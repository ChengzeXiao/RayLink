import { Resolver } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";

const SERVICES = [
  { id: "claude", label: "Claude", targets: [["claude-web", "Claude 网站", "https://claude.ai/"], ["claude-api", "Claude API", "https://api.anthropic.com/v1/models"]] },
  { id: "openai", label: "ChatGPT / OpenAI", targets: [["openai-web", "ChatGPT 网站", "https://chatgpt.com/"], ["openai-api", "OpenAI API", "https://api.openai.com/v1/models"]] },
  { id: "gemini", label: "Gemini", targets: [["gemini-web", "Gemini 网站", "https://gemini.google.com/"]] },
  { id: "copilot", label: "Copilot", targets: [["copilot-web", "Copilot 网站", "https://copilot.microsoft.com/"]] },
  { id: "perplexity", label: "Perplexity", targets: [["perplexity-web", "Perplexity 网站", "https://www.perplexity.ai/"]] },
  { id: "grok", label: "Grok", targets: [["grok-web", "Grok 网站", "https://grok.com/"]] }
];
export const AI_DIAGNOSTIC_SERVICES = Object.freeze(SERVICES.map(({ id, label }) => Object.freeze({ id, label })));
const TARGETS = SERVICES.flatMap(({ id: service, targets }) => targets.map(([id, label, url]) => ({ id, service, label, url })));
const COOLDOWN_MS = 60_000;
const PROBE_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 16_384;
const MAX_HEADER_BYTES = 65_536;
const LIMITATIONS = Object.freeze([
  "仅测量主控主机直接连接 AI 服务的 DNS、TLS 和 HTTP；不是客户端、移动网络或各代理协议的实测。",
  "匿名请求不携带账户、API Key 或 Cookie；无法证明账户可用、地区资格、模型调用或持续对话稳定性。",
  "验证页、权限错误和限流分别展示，不自动换节点、不改路由；远端地址是目标服务器地址，不是你的出口 IP。",
  "不跟随重定向；每个目标最多每 60 秒探测一次，结果可能来自缓存。"
]);

const blocked = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blocked.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) {
  blocked.addSubnet(ip, bits, "ipv6");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
function publicAddress(address) {
  if (typeof address !== "string" || address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
function normalizedAddress(address) {
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6 || address.includes("%")) return null;
  const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const mapped = normalized.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/i);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return normalized;
}
function failure(code, stage) {
  const error = new Error(code);
  error.code = code;
  error.stage = stage;
  return error;
}

const defaultProbe = {
  async resolve(host, { signal }) {
    const resolver = new Resolver({ timeout: 3_000, tries: 1 });
    const cancel = () => resolver.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) throw failure("DIAGNOSTIC_TIMEOUT", "dns");
      const answers = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
      const records = answers.flatMap((answer, index) => answer.status === "fulfilled"
        ? answer.value.map((address) => ({ address, family: index === 0 ? 4 : 6 })) : []);
      if (!records.length) throw failure("DIAGNOSTIC_DNS_ERROR", "dns");
      return records;
    } finally { signal.removeEventListener("abort", cancel); }
  },
  request({ url, address, family, signal, onStage }) {
    return new Promise((resolve, reject) => {
      let stage = "connect", remoteAddress = null, response, settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        if (error) { error.stage = error.stage || stage; reject(error); } else resolve(result);
        response?.destroy();
        request.destroy();
      };
      const request = https.request({
        protocol: "https:", hostname: url.hostname, port: 443,
        path: `${url.pathname}${url.search}`, method: "GET", servername: url.hostname,
        rejectUnauthorized: true, minVersion: "TLSv1.2", agent: false, signal,
        maxHeaderSize: MAX_HEADER_BYTES,
        headers: { "user-agent": "RayLink-AI-Diagnostics/1.0", accept: "text/html,application/json;q=0.9,*/*;q=0.1", "accept-encoding": "identity", connection: "close" },
        // DNS is resolved and validated once. Pin this socket to that address so
        // a later rebinding response cannot redirect the request into a LAN.
        lookup(_host, options, callback) {
          if (options.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        }
      }, (incoming) => {
        response = incoming;
        stage = "http";
        onStage?.(stage);
        const chunks = [];
        let size = 0;
        const complete = () => finish(null, {
          httpStatus: incoming.statusCode, headers: incoming.headers,
          body: Buffer.concat(chunks, size).toString("utf8"), remoteAddress
        });
        incoming.on("data", (chunk) => {
          const part = chunk.subarray(0, MAX_BODY_BYTES - size);
          chunks.push(part); size += part.length;
          if (size >= MAX_BODY_BYTES) complete();
        });
        incoming.once("end", complete);
        incoming.once("error", (error) => finish(error));
        incoming.once("aborted", () => finish(failure("ECONNRESET", "http")));
      });
      request.once("socket", (socket) => {
        socket.once("connect", () => {
          const peer = normalizedAddress(socket.remoteAddress);
          if (!publicAddress(peer) || peer !== normalizedAddress(address)) {
            finish(failure("DIAGNOSTIC_UNSAFE_ADDRESS", "connect"));
            return;
          }
          remoteAddress = peer;
          stage = "tls";
          onStage?.(stage);
        });
        socket.once("secureConnect", () => { stage = "http"; onStage?.(stage); });
      });
      request.once("error", (error) => finish(error));
      request.end();
    });
  }
};
export { defaultProbe as defaultAiDiagnosticProbe };

function httpOutcome(response) {
  const status = Number(response.httpStatus);
  const headers = response.headers || {};
  const marker = Object.entries(headers).find(([key]) => key.toLowerCase() === "cf-mitigated")?.[1];
  const body = typeof response.body === "string" ? response.body.slice(0, MAX_BODY_BYTES) : "";
  if (String(marker).toLowerCase() === "challenge" || /\/cdn-cgi\/challenge-platform\/|["']cf-chl-/i.test(body)) {
    return { status: "challenge", message: "收到网站验证页；这不是账户封禁或网络阻断的证明。" };
  }
  if (status === 401) return { status: "authentication_required", message: "已收到服务响应，需要认证；未验证账户或模型调用。" };
  if (status === 403) return { status: "permission_denied", message: "收到 HTTP 403；无足够证据判断是权限、地区限制还是其他拒绝原因。" };
  if (status === 429) return { status: "rate_limited", message: "请求受限（限流或额度等）；不应据此自动切换出口。" };
  if (status >= 500 && status <= 599) return { status: "upstream_error", message: "服务或中间网络返回服务器错误，请稍后复查。" };
  if (status >= 300 && status <= 399) return { status: "redirect", message: "服务返回重定向；未跟随跳转，无法判断后续页面。" };
  if (status >= 200 && status <= 299) return { status: "reachable", message: "已收到成功 HTTP 响应；不代表登录、模型调用或长连接已通过验证。" };
  if (status >= 400 && status <= 499) return { status: "permission_denied", message: "服务返回 HTTP 请求错误，拒绝原因未分类。" };
  return { status: "network_error", message: "未收到有效 HTTP 响应。" };
}
function errorOutcome(error, stage) {
  const code = String(error?.code || "");
  if (code === "AI_UPSTREAM_AUTH") return { status: "upstream_authentication_required", message: "上游代理认证失败，请检查代理用户名、密码或白名单；这不是 AI 账户认证错误。" };
  if (code === "HPE_HEADER_OVERFLOW") {
    return { status: "response_too_large", message: "响应头超过探测器的 64 KiB 上限；这是探测限制，不能据此判断线路故障。" };
  }
  if (["DIAGNOSTIC_TIMEOUT", "ABORT_ERR", "ETIMEDOUT", "ETIMEOUT"].includes(code)) {
    return { status: "timeout", message: "探测超时；仅凭超时无法判断是否受到网络封锁。" };
  }
  if (stage === "dns") return { status: "dns_error", message: code === "DIAGNOSTIC_UNSAFE_ADDRESS"
    ? "DNS 返回了非公网地址，已安全停止连接。" : "主控无法解析目标公网地址。" };
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(code)) {
    return { status: "tls_error", message: "TLS 握手或证书校验失败；未关闭证书验证。" };
  }
  return { status: "network_error", message: "主控与目标服务器的连接失败，具体网络原因未确认。" };
}

export class AiServiceDiagnostics {
  #probe;
  #cache = new Map();
  #pending = new Map();
  #requests = new Map();
  #active = 0;
  #queue = [];
  #snapshot = null;
  #source;
  #configRevision;

  constructor({ probe = defaultProbe, source = "control-plane-egress", configRevision = null } = {}) {
    if (!probe || typeof probe.resolve !== "function" || typeof probe.request !== "function") {
      throw new TypeError("AI diagnostic probe requires resolve and request functions");
    }
    this.#probe = probe;
    this.#source = source;
    this.#configRevision = configRevision;
  }

  snapshot() { return this.#snapshot ? structuredClone(this.#snapshot) : null; }

  async #measure(target) {
    if (this.#active >= 3) await new Promise((resolve) => this.#queue.push(resolve));
    else this.#active++;
    const started = Date.now();
    const controller = new AbortController();
    let stage = "dns", timer;
    try {
      const result = await Promise.race([
        (async () => {
          const url = new URL(target.url);
          const records = await this.#probe.resolve(url.hostname, { signal: controller.signal });
          if (controller.signal.aborted) throw failure("DIAGNOSTIC_TIMEOUT", stage);
          if (!Array.isArray(records) || !records.length || records.length > 32) throw failure("DIAGNOSTIC_DNS_ERROR", "dns");
          if (records.some(({ address, family }) => !publicAddress(address) || isIP(address) !== Number(family))) {
            throw failure("DIAGNOSTIC_UNSAFE_ADDRESS", "dns");
          }
          // IPv4 is preferred for this diagnostic, not a prediction of which
          // address family a particular client or proxy Runtime will select.
          const { address, family } = records.find((entry) => entry.family === 4) || records[0];
          stage = "connect";
          const response = await this.#probe.request({ url, address, family, signal: controller.signal,
            onStage(value) { if (["connect", "tls", "http"].includes(value)) stage = value; }
          });
          const remoteAddress = response.remoteAddress ? normalizedAddress(response.remoteAddress) : null;
          if (response.remoteAddress != null && (!publicAddress(remoteAddress) || remoteAddress !== normalizedAddress(address))) {
            throw failure("DIAGNOSTIC_UNSAFE_ADDRESS", "connect");
          }
          return { ...httpOutcome(response), stage: "http", httpStatus: Number.isInteger(response.httpStatus) ? response.httpStatus : null, remoteAddress };
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(failure("DIAGNOSTIC_TIMEOUT", stage));
            controller.abort();
          }, PROBE_TIMEOUT_MS);
        })
      ]);
      return { ...targetMetadata(target), ...result, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
    } catch (error) {
      const errorStage = ["dns", "connect", "tls", "http"].includes(error?.stage) ? error.stage : stage;
      return { ...targetMetadata(target), ...errorOutcome(error, errorStage), stage: errorStage,
        httpStatus: null, remoteAddress: null, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Transfer the occupied slot directly to the next waiter. Decrementing
      // before that waiter resumes would let a new request steal the same slot.
      const next = this.#queue.shift();
      if (next) next();
      else this.#active--;
    }
  }

  #target(target) {
    const cached = this.#cache.get(target.id);
    if (cached && Date.now() - cached.storedAt < COOLDOWN_MS) return Promise.resolve(cached.result);
    if (this.#pending.has(target.id)) return this.#pending.get(target.id);
    const pending = this.#measure(target).then((result) => {
      this.#cache.set(target.id, { result, storedAt: Date.now() });
      return result;
    }).finally(() => this.#pending.delete(target.id));
    this.#pending.set(target.id, pending);
    return pending;
  }

  async run({ service = "all" } = {}) {
    if (service !== "all" && !AI_DIAGNOSTIC_SERVICES.some(({ id }) => id === service)) {
      const error = new Error("请选择受支持的 AI 服务");
      error.code = "AI_DIAGNOSTIC_INVALID_SERVICE";
      error.statusCode = 422;
      throw error;
    }
    if (!this.#requests.has(service)) {
      const targets = TARGETS.filter((target) => service === "all" || target.service === service);
      const pending = Promise.all(targets.map((target) => this.#target(target))).then((results) => {
        const report = {
          service, checkedAt: results.map(({ checkedAt }) => checkedAt).sort().at(-1),
          source: this.#source, clientMeasured: false, authenticated: false,
          ...(this.#configRevision === null ? {} : { configRevision: this.#configRevision }),
          cooldownSeconds: COOLDOWN_MS / 1_000, results, limitations: this.#source === "control-plane-via-upstream"
            ? ["主控通过已配置上游代理连接固定 AI 目标；不是已发布 Runtime、客户端或移动网络的实测。目标公网 DNS 由主控预检，随后固定目标 IP 并严格校验目标 TLS。", ...LIMITATIONS.slice(1)]
            : [...LIMITATIONS]
        };
        this.#snapshot = report;
        return report;
      }).finally(() => this.#requests.delete(service));
      this.#requests.set(service, pending);
    }
    return structuredClone(await this.#requests.get(service));
  }
}
function targetMetadata({ id, service, label, url }) {
  return { id, service, label, host: new URL(url).hostname };
}
