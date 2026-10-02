import { isIP } from "node:net";
import { domainToASCII } from "node:url";

const localSuffixes = ["localhost", "local", "lan", "internal", "home.arpa", "in-addr.arpa", "ip6.arpa"];

function invalid(message) {
  throw Object.assign(new Error(message), { code: "INVALID_RUNTIME_DNS", statusCode: 422 });
}

function domain(value, field) {
  if (typeof value !== "string") invalid(`${field} 必须是有效域名`);
  const normalized = domainToASCII(value.trim().replace(/^\./, "").replace(/\.$/, "").toLowerCase());
  if (!normalized || normalized.length > 253 || normalized.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    invalid(`${field} 必须是有效域名`);
  }
  return normalized;
}

export function normalizeRuntimeDnsSettings(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Runtime DNS 配置必须为对象");
  const mode = input.mode ?? "auto";
  if (!["auto", "system"].includes(mode)) invalid("Runtime DNS 模式仅支持 auto 或 system");
  const primary = input.primary ?? "1.1.1.1";
  const secondary = input.secondary ?? "9.9.9.9";
  if (typeof primary !== "string" || !isIP(primary) || typeof secondary !== "string" || !isIP(secondary)) {
    invalid("Runtime DNS 的主用和备用地址必须是 IP，避免解析引导循环");
  }
  if (input.privateSuffixes !== undefined && !Array.isArray(input.privateSuffixes)) invalid("私有 DNS 后缀必须为数组");
  if ((input.privateSuffixes?.length || 0) > 64) invalid("私有 DNS 后缀最多 64 项");
  return {
    mode, primary, secondary,
    primaryServerName: domain(input.primaryServerName ?? "cloudflare-dns.com", "主用 DNS TLS 名称"),
    secondaryServerName: domain(input.secondaryServerName ?? "dns.quad9.net", "备用 DNS TLS 名称"),
    privateSuffixes: [...new Set((input.privateSuffixes || []).map(value => domain(value, "私有 DNS 后缀")))]
  };
}

export function buildRuntimeDnsPolicy(input, runtimeVersion = "1.13.0") {
  const settings = normalizeRuntimeDnsSettings(input);
  if (settings.mode === "system") return {};
  const server = (tag, address, serverName) => ({
    type: "https", tag, server: address, server_port: 443, path: "/dns-query", connect_timeout: "2s",
    tls: { enabled: true, server_name: serverName }
  });
  return {
    dns: {
      servers: [
        { type: "local", tag: "runtime-local" },
        server("runtime-primary", settings.primary, settings.primaryServerName),
        server("runtime-secondary", settings.secondary, settings.secondaryServerName)
      ],
      rules: [
        { domain_regex: ["^[^.]+$"], action: "route", server: "runtime-local" },
        { domain_suffix: [...new Set([...localSuffixes, ...settings.privateSuffixes])], action: "route", server: "runtime-local" },
        // Lookup retries the next rule/default server when an address-filtered
        // query fails. Listing two DNS servers alone does not provide failover.
        { ip_accept_any: true, action: "route", server: "runtime-primary" }
      ],
      final: "runtime-secondary", strategy: "prefer_ipv4", cache_capacity: 4096,
      ...(/^1\.14\./.test(runtimeVersion) ? { timeout: "2s" } : {})
    },
    route: {
      // Explicit resolve uses the DNS routing rules, including fallback. A
      // direct outbound resolver alone would bypass those rules. IPs are kept.
      rules: [{ action: "resolve", strategy: "prefer_ipv4" }],
      default_domain_resolver: "runtime-primary"
    }
  };
}
