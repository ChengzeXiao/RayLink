import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup as systemLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const failure = (code, message, statusCode = 422) => Object.assign(new Error(message), { code, statusCode });
export function normalizeNodeDomain(value) {
  if (typeof value !== "string") throw failure("INVALID_NODE_DOMAIN_SETTINGS", "请输入有效的完整域名");
  const name = value.trim().toLowerCase();
  if (isIP(name) || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) {
    throw failure("INVALID_NODE_DOMAIN_SETTINGS", "请输入完整域名，不含协议、端口或路径");
  }
  return name;
}
function canonicalIp(value) {
  return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}

// DNS credentials stay on the control plane, encrypted with a context-specific
// key derived from its existing master secret. Database backups remain secrets.
export class NodeDomains {
  constructor({ store, fetchImpl = fetch, lookup = (name) => systemLookup(name, { all: true, verbatim: true }), pollMs = 2000, waitMs = 120_000 }) {
    Object.assign(this, { store, fetchImpl, lookup, pollMs, waitMs });
    store.db.exec(`CREATE TABLE IF NOT EXISTS node_domain_bindings (
      host_id TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
      domain TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, zone_id TEXT NOT NULL, address TEXT NOT NULL
    )`);
  }
  rawSettings() {
    const row = this.store.db.prepare("SELECT value FROM settings WHERE key = 'node_domains'").get();
    return row ? JSON.parse(row.value) : { provider: "disabled", zoneId: "", baseDomain: "", autoProvision: false, inheritProtocols: true, encryptedToken: "" };
  }
  settings() {
    const { encryptedToken, ...value } = this.rawSettings();
    return { ...value, tokenConfigured: Boolean(encryptedToken) };
  }
  tokenKey() {
    const material = this.store.subscriptionEncryptionKey;
    if (!material) throw failure("NODE_DNS_CREDENTIAL_UNAVAILABLE", "DNS 凭据加密密钥不可用", 503);
    return createHash("sha256").update(`raylink-node-dns-v1:${material}`).digest();
  }
  encrypt(token) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.tokenKey(), iv);
    cipher.setAAD(Buffer.from("node-domains"));
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((value) => value.toString("base64url")).join(".");
  }
  decrypt(envelope) {
    try {
      const [iv, tag, ciphertext] = envelope.split(".").map((value) => Buffer.from(value, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", this.tokenKey(), iv);
      decipher.setAAD(Buffer.from("node-domains")); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch { throw failure("NODE_DNS_CREDENTIAL_UNAVAILABLE", "DNS 凭据不可用，请重新保存 Token", 503); }
  }
  updateSettings(input = {}) {
    const previous = this.rawSettings();
    const value = { ...previous };
    for (const key of ["autoProvision", "inheritProtocols"]) {
      if (input[key] !== undefined) {
        if (typeof input[key] !== "boolean") throw failure("INVALID_NODE_DOMAIN_SETTINGS", "自动配置选项须为布尔值");
        value[key] = input[key];
      }
    }
    if (input.provider !== undefined) value.provider = input.provider;
    if (!["disabled", "cloudflare"].includes(value.provider)) throw failure("INVALID_NODE_DOMAIN_SETTINGS", "请选择受支持的 DNS 服务商");
    if (input.zoneId !== undefined) value.zoneId = String(input.zoneId).trim();
    if (input.baseDomain !== undefined) value.baseDomain = input.baseDomain === "" ? "" : normalizeNodeDomain(input.baseDomain);
    if (input.apiToken !== undefined && (typeof input.apiToken !== "string" || input.apiToken.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(input.apiToken))) {
      throw failure("INVALID_NODE_DOMAIN_SETTINGS", "DNS API Token 格式不正确");
    }
    if (input.apiToken) value.encryptedToken = this.encrypt(input.apiToken);
    if (input.clearToken === true) value.encryptedToken = "";
    if (value.provider === "cloudflare" && (!/^[a-f0-9]{32}$/i.test(value.zoneId) || !value.baseDomain || !value.encryptedToken)) {
      throw failure("INVALID_NODE_DOMAIN_SETTINGS", "Cloudflare 需要 Zone ID、节点基础域名和 API Token");
    }
    if (value.provider === "disabled") value.autoProvision = false;
    this.store.db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES ('node_domains',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(JSON.stringify(value), new Date().toISOString());
    return this.settings();
  }
  async request(settings, path, { method = "GET", body, signal, zone = false } = {}) {
    try {
      const response = await this.fetchImpl(`https://api.cloudflare.com/client/v4/zones/${settings.zoneId}${zone ? "" : "/dns_records"}${path}`, {
        method, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${this.decrypt(settings.encryptedToken)}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (!response.ok) throw failure("NODE_DNS_API_FAILED", "Cloudflare 请求失败，请检查 Zone ID、DNS 读写权限和网络", 502);
      const value = await response.json();
      if (!value.success) throw failure("NODE_DNS_API_FAILED", "Cloudflare 未接受 DNS 操作，请检查域名和 Token 权限", 502);
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === "NODE_DNS_CREDENTIAL_UNAVAILABLE") throw error;
      throw failure("NODE_DNS_API_FAILED", "Cloudflare 请求未完成，请检查 Zone ID、DNS 读写权限和网络后重试", 502);
    }
  }
  async ensureRecord(binding, settings, signal) {
    const comment = `RayLink node ${binding.host_id}`;
    const type = isIP(binding.address) === 6 ? "AAAA" : "A";
    const read = async () => {
      const response = await this.request(settings, `?name.exact=${encodeURIComponent(binding.domain)}&per_page=100`, { signal });
      if (!Array.isArray(response.result) || response.result_info?.total_pages > 1) throw failure("NODE_DNS_RECORD_CONFLICT", "节点域名已有其他 DNS 记录，请使用独立子域名", 409);
      if (!response.result.length) return null;
      const owned = response.result.length === 1 && response.result[0];
      if (!owned || owned.name?.toLowerCase() !== binding.domain || owned.comment !== comment || owned.type !== type || canonicalIp(owned.content) !== canonicalIp(binding.address) || owned.proxied !== false) {
        throw failure("NODE_DNS_RECORD_CONFLICT", "节点域名已有不匹配或非本节点管理的 DNS 记录，未覆盖", 409);
      }
      return owned;
    };
    if (await read()) return;
    try {
      await this.request(settings, "", { method: "POST", signal, body: { type, name: binding.domain, content: binding.address, ttl: 1, proxied: false, comment } });
    } catch (error) {
      signal?.throwIfAborted();
      // A lost response may follow a committed write. Reconcile before retry.
      if (await read()) return;
      throw error;
    }
    if (!await read()) throw failure("NODE_DNS_API_FAILED", "DNS 记录写入后未能核实，请重试", 502);
  }
  async waitForResolution(binding, signal) {
    const deadline = Date.now() + this.waitMs;
    do {
      signal?.throwIfAborted();
      let answers = [];
      try {
        const timeout = AbortSignal.timeout(Math.min(5000, Math.max(1, deadline - Date.now())));
        const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
        answers = await new Promise((resolve, reject) => {
          const abort = () => reject(bounded.reason);
          bounded.addEventListener("abort", abort, { once: true });
          Promise.resolve().then(() => this.lookup(binding.domain)).then(resolve, reject).finally(() => bounded.removeEventListener("abort", abort));
        });
      } catch { signal?.throwIfAborted(); }
      if (answers.length && answers.every((answer) => canonicalIp(typeof answer === "string" ? answer : answer.address) === canonicalIp(binding.address))) return;
      if (Date.now() >= deadline) break;
      await delay(this.pollMs, undefined, { signal });
    } while (true);
    throw failure("NODE_DOMAIN_DNS_PENDING", "域名尚未完全解析到节点 IP，请检查 A/AAAA 记录、关闭 CDN 代理并等待解析生效后重试", 409);
  }
  async configure(host, input, signal) {
    const settings = this.rawSettings();
    const mode = input.domainMode || "auto";
    let binding = this.store.db.prepare("SELECT * FROM node_domain_bindings WHERE host_id=?").get(host.id);
    if (mode === "none" || (mode === "auto" && !binding && (!settings.autoProvision || settings.provider === "disabled"))) return { endpointDomain: null };
    const domain = mode === "existing" ? normalizeNodeDomain(input.endpointDomain) : binding?.domain || normalizeNodeDomain(`node-${host.id.replaceAll("-", "").slice(0, 12)}.${settings.baseDomain}`);
    if (!binding) {
      if (mode === "auto") {
        const zone = await this.request(settings, "", { signal, zone: true });
        const zoneName = zone.result?.name?.toLowerCase();
        if (!zoneName || !domain.endsWith(`.${zoneName}`)) throw failure("NODE_DNS_ZONE_MISMATCH", "节点基础域名不属于配置的 Cloudflare Zone，请修正后重试");
      }
      binding = { host_id: host.id, domain, provider: mode === "existing" ? "existing" : settings.provider, zone_id: mode === "existing" ? "" : settings.zoneId, address: host.address };
      const used = this.store.db.prepare("SELECT host_id FROM node_domain_bindings WHERE domain=?").get(domain);
      if (used) throw failure("NODE_DOMAIN_BINDING_CONFLICT", "域名已绑定其他节点，请使用独立子域名", 409);
      this.store.db.prepare("INSERT INTO node_domain_bindings(host_id,domain,provider,zone_id,address) VALUES (?,?,?,?,?)").run(host.id, domain, binding.provider, binding.zone_id, host.address);
    }
    if (binding.address !== host.address || binding.domain !== domain || (mode === "existing") !== (binding.provider === "existing")) {
      throw failure("NODE_DOMAIN_BINDING_CONFLICT", "节点域名绑定与接入任务不一致，未修改原记录", 409);
    }
    if (binding.provider === "cloudflare") {
      if (settings.provider !== "cloudflare" || settings.zoneId !== binding.zone_id) throw failure("NODE_DOMAIN_BINDING_CONFLICT", "DNS 服务商或 Zone 已变化，请恢复原配置后重试", 409);
      await this.ensureRecord(binding, settings, signal);
    }
    await this.waitForResolution(binding, signal);
    this.store.setHostEndpointDomain(host.id, binding.domain);
    return { endpointDomain: binding.domain };
  }
}
