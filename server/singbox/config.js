import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { buildRuntimeDnsPolicy } from "./runtime-dns.js";
import { AI_UPSTREAM_DOMAIN_NAMES, AI_UPSTREAM_DOMAIN_SUFFIXES } from "../routing/ai-upstream-domains.js";
import {
  buildProtocolInbounds,
  defaultProtocolConfigs
} from "./protocol-catalog.js";

function isEligibleUser(user, hostRegion, now) {
  if (!["active", "warning"].includes(user.state)) return false;
  if (user.portalStatus !== "active") return false;
  if (user.usedGb >= user.quotaGb) return false;
  const expiresAt = new Date(`${user.expiresAt}T23:59:59.999Z`);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt < now) return false;
  return user.nodeScope.includes("all") || user.nodeScope.includes(hostRegion);
}

function applyAiUpstream(config, snapshot) {
  const upstream = snapshot.aiUpstream;
  if (!upstream?.enabled) return;
  if (snapshot.host.kind === "remote" || (snapshot.host.id && snapshot.host.id !== "local")
    || upstream.hostId !== "local" || !["socks5", "http", "https"].includes(upstream.type)
    || typeof upstream.server !== "string" || !upstream.server
    || !Number.isInteger(upstream.port) || upstream.port < 1 || upstream.port > 65535) {
    throw Object.assign(new Error("AI 住宅出口配置无效或不属于本机"), { code: "INVALID_AI_UPSTREAM_RUNTIME", statusCode: 422 });
  }
  const outbound = {
    type: upstream.type === "socks5" ? "socks" : "http",
    tag: "ai-residential", server: upstream.server, server_port: upstream.port,
    ...(upstream.username ? { username: upstream.username } : {}),
    ...(upstream.password ? { password: upstream.password } : {}),
    connect_timeout: "10s",
    ...(upstream.type === "socks5" ? { version: "5", network: "tcp" } : {}),
    ...(upstream.type === "https" ? { tls: { enabled: true, server_name: upstream.tlsServerName || upstream.server } } : {})
  };
  // Bootstrap only the upstream endpoint locally. Target AI domains remain
  // intact for SOCKS5/CONNECT remote DNS. Never resolve through the upstream
  // itself before its own endpoint has been connected.
  if (!isIP(upstream.server)) {
    if (!config.dns) {
      config.dns = { servers: [{ type: "local", tag: "runtime-ai-bootstrap" }], final: "runtime-ai-bootstrap" };
      config.route.default_domain_resolver = "runtime-ai-bootstrap";
    }
    outbound.domain_resolver = config.route.default_domain_resolver;
  }
  config.outbounds.push(outbound);
  const aiRules = () => [
    { domain: [...AI_UPSTREAM_DOMAIN_NAMES], domain_suffix: [...AI_UPSTREAM_DOMAIN_SUFFIXES], network: "udp", action: "reject" },
    { domain: [...AI_UPSTREAM_DOMAIN_NAMES], domain_suffix: [...AI_UPSTREAM_DOMAIN_SUFFIXES], network: "tcp", action: "route", outbound: "ai-residential" }
  ];
  config.route.rules = [
    // Prefer the original proxy destination over sniffed outer TLS names (ECH
    // can hide the real SNI). Sniffing is only a fallback for IP destinations.
    ...aiRules(),
    { action: "sniff", sniffer: ["http", "tls", "quic"], timeout: "300ms" },
    ...aiRules(),
    ...(config.route.rules || [])
  ];
}

export function buildSingBoxConfig(snapshot, options = {}) {
  const now = options.now || new Date();
  const listenPort = options.listenPort || 8388;
  const users = snapshot.users.filter((user) => isEligibleUser(user, snapshot.host.region, now));
  const profiles = snapshot.protocols || defaultProtocolConfigs(listenPort);

  const config = {
    log: {
      level: "info",
      timestamp: true
    },
    inbounds: buildProtocolInbounds({
      profiles,
      users,
      masterPassword: snapshot.masterPassword,
      runtimeVersion: snapshot.host.runtimeVersion || "1.13.0"
    }),
    outbounds: [{
      type: "direct",
      tag: "direct"
    }],
    route: {
      final: "direct"
    }
  };
  const runtimeDns = buildRuntimeDnsPolicy(options.runtimeDns, snapshot.host.runtimeVersion);
  if (runtimeDns.dns) {
    config.dns = runtimeDns.dns;
    Object.assign(config.route, runtimeDns.route);
  }
  applyAiUpstream(config, snapshot);
  const providers = new Map();
  let usesHttpChallenge = false;
  for (const inbound of config.inbounds) {
    const provider = inbound.tls?.certificate_provider || inbound.tls?.acme;
    if (!provider || (provider.type && provider.type !== "acme")) continue;
    usesHttpChallenge ||= !provider.disable_http_challenge && !provider.dns01_challenge;
    if (snapshot.host.kind === "remote") provider.data_directory = "/var/lib/raylink-node/sing-box/acme";
    if (!inbound.tls.certificate_provider) continue;
    const domain = provider.domain[0].toLowerCase();
    const existing = providers.get(domain);
    if (existing && JSON.stringify(existing.options) !== JSON.stringify(provider)) {
      throw Object.assign(new Error(`域名 ${domain} 的 ACME 参数不一致`), { code: "ACME_PROVIDER_CONFLICT", statusCode: 422 });
    }
    const tag = existing?.tag || `acme-${createHash("sha256").update(domain).digest("hex").slice(0, 16)}`;
    providers.set(domain, { tag, options: provider });
    inbound.tls.certificate_provider = tag;
  }
  if (providers.size) config.certificate_providers = [...providers.values()].map(({ tag, options: provider }) => ({ ...provider, tag }));
  if (usesHttpChallenge && config.inbounds.some((inbound) => inbound.listen_port === 80
    && !["hysteria", "hysteria2", "tuic"].includes(inbound.type)
    && inbound.transport?.type !== "quic" && inbound.network !== "udp")) {
    throw Object.assign(new Error("TCP80 必须保留给 ACME HTTP-01 挑战，请更换协议监听端口"), { code: "ACME_CHALLENGE_PORT_OCCUPIED", statusCode: 409 });
  }
  if (snapshot.host.buildTags?.includes("with_v2ray_api")) {
    config.experimental = {
      v2ray_api: {
        listen: "127.0.0.1:10085",
        stats: {
          enabled: true,
          users: users.map((user) => user.email)
        }
      }
    };
  }
  return config;
}
