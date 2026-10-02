import { createHmac } from "node:crypto";

import {
  AI_DOMAIN_NAMES,
  AI_DOMAIN_SUFFIXES,
  DEFAULT_ROUTE_PROBE_URL,
  LOCAL_DOMAIN_SUFFIXES,
  normalizeRoutingPolicy,
  PROXY_DOMAIN_SUFFIXES,
  ROUTE_POLICY_GROUPS
} from "../routing/policy.js";
import { getBundledRoutingRules } from "../routing/rule-sets/bundled.js";

const sourceRoot = "https://github.com/SagerNet/sing-box/tree/v1.14.2";
const docsRoot = "https://sing-box.sagernet.org/configuration/inbound";
const protocolProbeTypes = new Set([
  "shadowsocks",
  "vmess",
  "vless",
  "trojan",
  "naive",
  "anytls",
  "hysteria",
  "tuic",
  "hysteria2"
]);
const protocolProbeUserName = "raylink-probe@internal";

function protocolProbeUser(masterPassword, type) {
  const passwordBytes = createHmac("sha256", masterPassword)
    .update(`raylink-probe-password:${type}`)
    .digest();
  const password = type === "shadowsocks"
    ? passwordBytes.subarray(0, 16).toString("base64")
    : passwordBytes.toString("base64url").slice(0, 32);
  const uuidBytes = createHmac("sha256", masterPassword)
    .update(`raylink-probe-uuid:${type}`)
    .digest()
    .subarray(0, 16);
  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x40;
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
  const hex = uuidBytes.toString("hex");
  return {
    email: protocolProbeUserName,
    runtimePassword: password,
    runtimeUuid: [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join("-")
  };
}

export const protocolCatalog = [
  protocol("shadowsocks", "Shadowsocks 2022", 8388, "密码型多用户协议，RayLink 默认入口。", { clientCapable: true }),
  protocol("vmess", "VMess", 8443, "V2Ray 用户 UUID 协议，可选 TLS 与 V2Ray Transport。", {
    authMode: "uuid",
    clientCapable: true,
    tls: "optional",
    transports: true,
    reality: true
  }),
  protocol("trojan", "Trojan", 9443, "基于 TLS 的密码型协议。", {
    clientCapable: true,
    tls: "required",
    transports: true,
    reality: true
  }),
  protocol("naive", "Naive", 7443, "基于 HTTP/2 或 HTTP/3 的认证代理。", {
    authMode: "username-password",
    clientCapable: true,
    clientRequiredTags: ["with_naive_outbound"],
    tls: "required"
  }),
  protocol("shadowtls", "ShadowTLS", 7444, "TLS 握手代理层，通常与其他入站组合使用。", {
    clientCapable: false,
    tls: "external",
    formLevel: "advanced"
  }),
  protocol("vless", "VLESS", 8444, "UUID 用户协议，可选 TLS、Reality 与 V2Ray Transport。", {
    authMode: "uuid",
    clientCapable: true,
    tls: "optional",
    transports: true,
    reality: true
  }),
  protocol("anytls", "AnyTLS", 8445, "基于 TLS 的密码型会话协议。", {
    clientCapable: true,
    tls: "required",
    reality: true
  }),
  protocol("hysteria", "Hysteria", 8446, "基于 QUIC 的 UDP 传输协议。", {
    clientCapable: true,
    tls: "required",
    requiredTags: ["with_quic"]
  }),
  protocol("tuic", "TUIC", 8447, "基于 QUIC 的 UUID 与密码协议。", {
    authMode: "uuid-password",
    clientCapable: true,
    tls: "required",
    requiredTags: ["with_quic"]
  }),
  protocol("hysteria2", "Hysteria 2", 8448, "基于 QUIC 的密码型协议。", {
    clientCapable: true,
    tls: "required",
    requiredTags: ["with_quic"]
  }),
  protocol("socks", "SOCKS", 1080, "标准 SOCKS4/4a/5 入站。", {
    authMode: "username-password",
    clientCapable: true,
    exposure: "private"
  }),
  protocol("http", "HTTP Proxy", 8080, "HTTP CONNECT 代理，可选 TLS。", {
    authMode: "username-password",
    clientCapable: true,
    tls: "optional",
    exposure: "private"
  }),
  protocol("mixed", "Mixed", 2080, "在同一端口接受 SOCKS 与 HTTP。", {
    authMode: "username-password",
    clientCapable: true,
    tls: "optional",
    exposure: "private"
  }),
  protocol("direct", "Direct", 9090, "接收入站并直接连接到目标地址。", {
    authMode: "none",
    clientCapable: false,
    exposure: "system",
    formLevel: "advanced"
  }),
  protocol("tun", "TUN", null, "系统三层虚拟网卡入站。", {
    authMode: "none",
    clientCapable: false,
    exposure: "system",
    portless: true,
    formLevel: "advanced"
  }),
  protocol("redirect", "Redirect", 9091, "Linux/macOS 透明代理重定向入口。", {
    authMode: "none",
    clientCapable: false,
    exposure: "system",
    platforms: ["linux", "darwin"],
    formLevel: "advanced"
  }),
  protocol("tproxy", "TProxy", 9092, "Linux TProxy 透明代理入口。", {
    authMode: "none",
    clientCapable: false,
    exposure: "system",
    platforms: ["linux"],
    formLevel: "advanced",
    sourceUrl: `${sourceRoot}/protocol/redirect`
  })
];

const protocolByType = new Map(protocolCatalog.map((item) => [item.type, item]));

function protocol(type, name, defaultPort, description, overrides = {}) {
  return {
    type,
    name,
    defaultPort,
    description,
    authMode: "password",
    clientCapable: false,
    tls: "none",
    transports: false,
    reality: false,
    requiredTags: [],
    clientRequiredTags: [],
    platforms: ["linux", "darwin", "win32"],
    exposure: "public",
    formLevel: "managed",
    portless: false,
    sourceUrl: `${sourceRoot}/protocol/${type}`,
    docsUrl: `${docsRoot}/${type}/`,
    ...overrides
  };
}

export function defaultProtocolConfigs(shadowsocksPort = 8388) {
  return protocolCatalog.map((entry) => ({
    type: entry.type,
    enabled: entry.type === "shadowsocks",
    listen: "::",
    port: entry.type === "shadowsocks" ? shadowsocksPort : entry.defaultPort,
    tls: {
      mode: "none",
      serverName: "",
      certificatePath: "",
      keyPath: "",
      handshakeServer: "",
      handshakePort: 443,
      privateKey: "",
      publicKey: "",
      shortId: "",
      acmeEmail: "",
      acmeDataDirectory: "/var/lib/raylink/acme"
    },
    transport: {
      type: "none",
      path: "",
      serviceName: ""
    },
    options: entry.type === "hysteria"
      ? { up_mbps: 100, down_mbps: 100 }
      : {}
  }));
}

export function normalizeProtocolConfigs(input, shadowsocksPort = 8388) {
  const defaults = defaultProtocolConfigs(shadowsocksPort);
  const supplied = new Map(
    (Array.isArray(input) ? input : []).map((profile) => [String(profile?.type || ""), profile])
  );
  return defaults.map((fallback) => normalizeProtocolConfig({
    ...fallback,
    ...(supplied.get(fallback.type) || {})
  }));
}

export function normalizeProtocolConfig(input) {
  const type = String(input?.type || "");
  const catalog = protocolByType.get(type);
  if (!catalog) throw protocolError("PROTOCOL_NOT_FOUND", "sing-box 入站协议不存在", 404);
  const profile = {
    type,
    enabled: input.enabled === true,
    listen: String(input.listen || "::").trim(),
    port: catalog.portless ? null : Number(input.port),
    tls: {
      mode: String(input.tls?.mode || "none"),
      serverName: String(input.tls?.serverName || "").trim(),
      certificatePath: String(input.tls?.certificatePath || "").trim(),
      keyPath: String(input.tls?.keyPath || "").trim(),
      handshakeServer: String(input.tls?.handshakeServer || "").trim(),
      handshakePort: Number(input.tls?.handshakePort || 443),
      privateKey: String(input.tls?.privateKey || "").trim(),
      publicKey: String(input.tls?.publicKey || "").trim(),
      shortId: String(input.tls?.shortId || "").trim(),
      acmeEmail: String(input.tls?.acmeEmail || "").trim(),
      acmeDataDirectory: String(
        input.tls?.acmeDataDirectory || "/var/lib/raylink/acme"
      ).trim()
    },
    transport: {
      type: String(input.transport?.type || "none"),
      path: String(input.transport?.path || "").trim(),
      serviceName: String(input.transport?.serviceName || "").trim()
    },
    options: normalizeProtocolOptions(type, input.options)
  };
  if (!profile.listen) throw protocolError("INVALID_LISTEN", "监听地址不能为空");
  if (!catalog.portless && (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65_535)) {
    throw protocolError("INVALID_PROTOCOL_PORT", "协议端口必须在 1–65535 之间");
  }
  if (!["none", "certificate", "reality", "acme"].includes(profile.tls.mode)) {
    throw protocolError("INVALID_TLS_MODE", "TLS 模式不受支持");
  }
  if (profile.enabled && catalog.tls === "required" && profile.tls.mode === "none") {
    throw protocolError("TLS_REQUIRED", `${catalog.name} 必须配置证书 TLS 或 Reality`);
  }
  if (profile.tls.mode === "certificate" && (!profile.tls.certificatePath || !profile.tls.keyPath)) {
    throw protocolError("TLS_CERTIFICATE_REQUIRED", "证书模式必须填写证书和私钥路径");
  }
  if (
    profile.tls.mode === "acme"
    && (!profile.tls.serverName || !profile.tls.acmeEmail || !profile.tls.acmeDataDirectory)
  ) {
    throw protocolError("TLS_ACME_REQUIRED", "ACME 模式必须填写节点域名、通知邮箱和数据目录");
  }
  if (profile.tls.mode === "reality") {
    if (!catalog.reality) throw protocolError("REALITY_NOT_SUPPORTED", `${catalog.name} 不支持 Reality`);
    if (!Number.isInteger(profile.tls.handshakePort)
      || profile.tls.handshakePort < 1
      || profile.tls.handshakePort > 65_535) {
      throw protocolError("INVALID_REALITY_PORT", "Reality 握手端口必须在 1–65535 之间");
    }
    const required = ["serverName", "handshakeServer", "privateKey", "publicKey", "shortId"];
    if (required.some((field) => !profile.tls[field])) {
      throw protocolError("REALITY_FIELDS_REQUIRED", "Reality 需要服务器名称、握手地址、密钥对和 Short ID");
    }
  }
  if (!["none", "http", "ws", "quic", "grpc", "httpupgrade"].includes(profile.transport.type)) {
    throw protocolError("INVALID_TRANSPORT", "V2Ray Transport 类型不受支持");
  }
  if (profile.transport.type !== "none" && !catalog.transports) {
    throw protocolError("TRANSPORT_NOT_SUPPORTED", `${catalog.name} 不支持 V2Ray Transport`);
  }
  if (profile.enabled && profile.transport.type === "quic" && profile.tls.mode === "none") {
    throw protocolError("TRANSPORT_TLS_REQUIRED", "QUIC Transport 必须启用证书 TLS 或 Reality");
  }
  return profile;
}

export function assertProtocolSet(profiles) {
  const enabledPorts = new Map();
  for (const profile of profiles) {
    const catalog = protocolByType.get(profile.type);
    if (!profile.enabled || catalog.portless) continue;
    if (enabledPorts.has(profile.port)) {
      throw protocolError(
        "PROTOCOL_PORT_CONFLICT",
        `${catalog.name} 与 ${enabledPorts.get(profile.port)} 使用了相同端口 ${profile.port}`
      );
    }
    enabledPorts.set(profile.port, catalog.name);
  }
}

export function protocolAvailability(catalog, installation) {
  const tags = new Set(installation?.tags || []);
  const requiredTags = [
    ...catalog.requiredTags,
    ...(catalog.clientCapable ? catalog.clientRequiredTags : [])
  ];
  const versionSupported = /^1\.(?:13|14)\.\d+$/.test(String(installation?.version || ""));
  return {
    ...catalog,
    available: installation?.installed === true
      && versionSupported
      && catalog.platforms.includes(installation.platform)
      && requiredTags.every((tag) => tags.has(tag)),
    missingTags: requiredTags.filter((tag) => !tags.has(tag)),
    versionSupported,
    platformSupported: catalog.platforms.includes(installation?.platform || ""),
    realityAvailable: catalog.reality && tags.has("with_utls"),
    quicTransportAvailable: catalog.transports && tags.has("with_quic")
  };
}

export function buildProtocolInbounds({ profiles, users, masterPassword, runtimeVersion = "1.14.2" }) {
  return profiles.filter((profile) => profile.enabled).map((profile) => {
    const catalog = protocolByType.get(profile.type);
    const base = {
      ...profile.options,
      type: profile.type,
      tag: profile.type === "shadowsocks" ? "managed-shadowsocks" : `raylink-${profile.type}`
    };
    if (!catalog.portless) {
      base.listen = profile.listen;
      base.listen_port = profile.port;
    }
    const tls = buildServerTls(profile, runtimeVersion);
    // TUIC clients such as Mihomo require a negotiated ALPN, even though
    // sing-box peers can both omit it. Keep managed server/client TLS aligned.
    if (tls && profile.type === "tuic") tls.alpn = ["h3"];
    if (tls) base.tls = tls;
    const transport = buildTransport(profile);
    if (transport) base.transport = transport;
    const serverUsers = protocolProbeTypes.has(profile.type)
      ? [...users, protocolProbeUser(masterPassword, profile.type)]
      : users;
    applyServerUsers(base, profile.type, serverUsers, masterPassword);
    return base;
  });
}

export function buildProtocolClientConfig({
  profiles,
  credential,
  server,
  ruleSetBaseUrl = null,
  probeUrl = DEFAULT_ROUTE_PROBE_URL,
  routePolicy
}) {
  const managed = profiles.filter((profile) => {
    const catalog = protocolByType.get(profile.type);
    return profile.enabled && catalog?.clientCapable && catalog.exposure === "public";
  });
  const protocolOutbounds = managed.map((profile) => buildClientOutbound(profile, credential, server));
  return clientConfigForOutbounds(protocolOutbounds, {
    ruleSetBaseUrl,
    probeUrl,
    routePolicy
  });
}

const udpClientProtocolTypes = new Set(["hysteria", "hysteria2", "tuic"]);
const UDP_STABLE_JITTER_LIMIT_MS = 80;
export const SMART_PROTOCOL_HEALTH_MAX_AGE_MS = 15 * 60_000;

function usesUdpTransport(protocol) {
  return udpClientProtocolTypes.has(protocol.type) || protocol.transport?.type === "quic";
}

function protocolIsStableForSmartSelection(activation, now) {
  const check = activation?.publicCheck;
  const recent = (value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp <= now + 60_000
      && now - timestamp <= SMART_PROTOCOL_HEALTH_MAX_AGE_MS;
  };
  const rounds = Array.isArray(check?.healthWindow?.rounds) ? check.healthWindow.rounds : [];
  return check?.availability === "available"
    && recent(check.checkedAt)
    && check.reachable === true
    && Number(check.consecutiveFailures || 0) === 0
    && Number(check.samples?.successful || 0) >= 4
    && rounds.filter((round) => recent(round?.checkedAt)).length >= 3
    && Number(check.healthWindow?.successRate || 0) >= 95
    && typeof check.jitterMs === "number"
    && Number.isFinite(check.jitterMs)
    && check.jitterMs >= 0
    && Number(check.jitterMs) <= UDP_STABLE_JITTER_LIMIT_MS;
}

export function buildMultiHostProtocolClientConfig({
  credential,
  hosts,
  ruleSetBaseUrl = null,
  probeUrl = DEFAULT_ROUTE_PROBE_URL,
  routePolicy,
  now = Date.now()
}) {
  const smartExcludedTags = new Set();
  const protocolOutbounds = hosts.flatMap((host) => {
    const managed = (host.protocols || [])
      .filter((profile) => {
        const catalog = protocolByType.get(profile.type);
        return profile.enabled && catalog?.clientCapable && catalog.exposure === "public";
      });
    const hostTag = String(host.id || host.name || "node")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "node";
    const activations = new Map(
      (host.protocolActivations || []).map((activation) => [activation.type, activation])
    );
    return managed.map((profile) => {
      const tag = `raylink-${hostTag}-${profile.type}`;
      if (
        usesUdpTransport(profile)
        && !protocolIsStableForSmartSelection(activations.get(profile.type), now)
      ) {
        smartExcludedTags.add(tag);
      }
      return buildClientOutbound(profile, credential, host.endpointDomain || host.address, tag);
    });
  });
  return clientConfigForOutbounds(protocolOutbounds, {
    ruleSetBaseUrl,
    smartExcludedTags,
    probeUrl,
    routePolicy
  });
}

function urlTestOutbound(tag, outbounds, probeUrl, tolerance = 50) {
  return {
    type: "urltest",
    tag,
    outbounds,
    url: probeUrl,
    interval: "3m",
    tolerance,
    interrupt_exist_connections: false
  };
}

function clientConfigForOutbounds(
  protocolOutbounds,
  {
    ruleSetBaseUrl = null,
    smartExcludedTags = new Set(),
    probeUrl = DEFAULT_ROUTE_PROBE_URL,
    routePolicy: inputRoutePolicy
  } = {}
) {
  const routePolicy = normalizeRoutingPolicy(inputRoutePolicy);
  if (!protocolOutbounds.length) throw protocolError("NO_CLIENT_PROTOCOL", "当前没有可下发的用户协议", 409);
  const tags = protocolOutbounds.map((outbound) => outbound.tag);
  const tcpTags = protocolOutbounds
    .filter((outbound) => !usesUdpTransport(outbound))
    .map((outbound) => outbound.tag);
  const udpTags = protocolOutbounds
    .filter(usesUdpTransport)
    .map((outbound) => outbound.tag);
  const healthyUdpTags = udpTags.filter((tag) => !smartExcludedTags.has(tag));
  const smartTags = [...tcpTags, ...healthyUdpTags];
  const usableSmartTags = smartTags.length ? smartTags : tags;
  const automaticGroups = [
    urlTestOutbound("raylink-smart", usableSmartTags, probeUrl, 80),
    ...(tcpTags.length ? [urlTestOutbound("raylink-tcp", tcpTags, probeUrl)] : []),
    ...(udpTags.length ? [urlTestOutbound("raylink-udp", udpTags, probeUrl)] : []),
    urlTestOutbound("raylink-fastest", tags, probeUrl)
  ];
  // Native URLTest has no ordered fallback. A tolerance equal to its 15s
  // probe deadline keeps a healthy AI exit stable; failed probes remove it.
  // Leave headroom for uint16 delay + tolerance arithmetic in sing-box.
  const aiStableGroup = {
    ...urlTestOutbound(ROUTE_POLICY_GROUPS.aiStable.tag, tcpTags.length ? tcpTags : usableSmartTags, probeUrl, 15_000),
    interval: "1m"
  };
  for (const outbound of automaticGroups) {
    if (outbound.tag === ROUTE_POLICY_GROUPS.tcp.tag) outbound.interval = "1m";
  }
  const selectorGroups = automaticGroups.map((outbound) => outbound.tag);
  const ruleSets = ruleSetBaseUrl
    ? [
        {
          type: "remote",
          tag: "geosite-geolocation-cn",
          format: "binary",
          url: new URL("geosite-geolocation-cn.srs", ruleSetBaseUrl).toString(),
          download_detour: "direct",
          update_interval: "1d"
        },
        {
          type: "remote",
          tag: "geoip-cn",
          format: "binary",
          url: new URL("geoip-cn.srs", ruleSetBaseUrl).toString(),
          download_detour: "direct",
          update_interval: "1d"
        }
      ]
    : [
        {
          type: "inline",
          tag: "geosite-geolocation-cn",
          rules: getBundledRoutingRules().geosite
        },
        {
          type: "inline",
          tag: "geoip-cn",
          rules: getBundledRoutingRules().geoip
        }
      ];
  const customDnsRules = routePolicy.rules.flatMap((rule) => {
    if (!rule.enabled || !["domain", "domain_suffix"].includes(rule.match)) return [];
    const field = rule.match === "domain" ? "domain" : "domain_suffix";
    return [{
      [field]: [rule.value],
      action: "route",
      server: rule.dns === "system" ? "dns-local"
        : rule.dns === "domestic" ? "dns-domestic"
          : rule.action === "ai" ? "dns-ai" : "dns-remote"
    }];
  });
  let resolvesCustomIps = false;
  const customRouteRules = routePolicy.rules.flatMap((rule) => {
    if (!rule.enabled) return [];
    const field = {
      domain: "domain",
      domain_suffix: "domain_suffix",
      ip: "ip_cidr",
      ip_cidr: "ip_cidr"
    }[rule.match];
    const value = rule.match === "ip"
      ? `${rule.value}/${String(rule.value).includes(":") ? 128 : 32}`
      : rule.value;
    const resolveRules = field === "ip_cidr" && !resolvesCustomIps
      ? [{ action: "resolve" }]
      : [];
    if (field === "ip_cidr") resolvesCustomIps = true;
    if (rule.action === "block") {
      return [...resolveRules, { [field]: [value], action: "reject" }];
    }
    return [...resolveRules,
      ...(field !== "ip_cidr" && !resolvesCustomIps
        ? [{ [field]: [value], action: "resolve" }] : []), {
      [field]: [value],
      action: "route",
      outbound: rule.action === "direct"
        ? ROUTE_POLICY_GROUPS.direct.tag
        : rule.action === "ai"
          ? ROUTE_POLICY_GROUPS.ai.tag
          : ROUTE_POLICY_GROUPS.proxy.tag
    }];
  });
  // Keep the exact addresses already checked by earlier IP rules. Re-resolving
  // a TTL=0/rotating answer here could dial an IP that those rules would reject.
  const resolveRemaining = (match = {}) => resolvesCustomIps ? [] : [{ ...match, action: "resolve" }];
  const managedRouteRules = routePolicy.mode === "smart"
    ? [
        ...resolveRemaining({ domain: [...AI_DOMAIN_NAMES], domain_suffix: [...AI_DOMAIN_SUFFIXES] }),
        {
          domain: [...AI_DOMAIN_NAMES],
          domain_suffix: [...AI_DOMAIN_SUFFIXES],
          action: "route",
          outbound: ROUTE_POLICY_GROUPS.ai.tag
        },
        ...resolveRemaining({ domain_suffix: [...PROXY_DOMAIN_SUFFIXES] }),
        {
          domain_suffix: [...PROXY_DOMAIN_SUFFIXES],
          action: "route",
          outbound: ROUTE_POLICY_GROUPS.proxy.tag
        },
        ...resolveRemaining({ rule_set: "geosite-geolocation-cn" }),
        {
          rule_set: "geosite-geolocation-cn",
          action: "route",
          outbound: ROUTE_POLICY_GROUPS.direct.tag
        },
        // SOCKS/HTTP hostname requests have no destination IP until resolved.
        // default_domain_resolver only affects dialing, after rule selection.
        ...resolveRemaining(),
        {
          ip_is_private: true,
          action: "route",
          outbound: ROUTE_POLICY_GROUPS.direct.tag
        },
        {
          rule_set: "geoip-cn",
          action: "route",
          outbound: ROUTE_POLICY_GROUPS.direct.tag
        }
      ]
    : [
        ...resolveRemaining(),
        { ip_is_private: true, action: "route", outbound: ROUTE_POLICY_GROUPS.direct.tag }
      ];
  return {
    log: { level: "info", timestamp: true },
    dns: {
      timeout: "5s",
      cache_capacity: 4096,
      optimistic: { enabled: true, timeout: "30s" },
      servers: [
        {
          type: "local",
          tag: "dns-local"
        },
        {
          type: "https",
          tag: "dns-domestic",
          server: "223.5.5.5",
          path: "/dns-query"
        },
        {
          type: "tls",
          tag: "dns-remote",
          server: "8.8.8.8",
          detour: "raylink-auto"
        },
        {
          type: "tls",
          tag: "dns-ai",
          server: "8.8.8.8",
          detour: ROUTE_POLICY_GROUPS.ai.tag
        }
      ],
      rules: [
        {
          domain: ["localhost"],
          domain_suffix: [...LOCAL_DOMAIN_SUFFIXES],
          action: "route",
          server: "dns-local"
        },
        ...customDnsRules,
        ...(routePolicy.mode === "smart" ? [{
          domain: [...AI_DOMAIN_NAMES],
          domain_suffix: [...AI_DOMAIN_SUFFIXES],
          action: "route",
          server: "dns-ai"
        }, {
          domain_suffix: [...PROXY_DOMAIN_SUFFIXES],
          action: "route",
          server: "dns-remote"
        }, {
          rule_set: "geosite-geolocation-cn",
          action: "route",
          server: "dns-domestic"
        }] : [])
      ],
      final: routePolicy.mode === "direct" ? "dns-domestic" : "dns-remote",
      strategy: "prefer_ipv4"
    },
    inbounds: [
      {
        type: "tun",
        tag: "local-tun",
        address: ["172.19.0.1/30"],
        auto_route: true,
        strict_route: true,
        stack: "system"
      },
      {
        type: "mixed",
        tag: "local-mixed",
        listen: "127.0.0.1",
        listen_port: 2080
      }
    ],
    outbounds: [
      ...protocolOutbounds,
      ...automaticGroups,
      aiStableGroup,
      {
        type: "selector",
        tag: ROUTE_POLICY_GROUPS.proxy.tag,
        outbounds: [...selectorGroups, ...tags],
        default: tcpTags.length ? ROUTE_POLICY_GROUPS.tcp.tag : ROUTE_POLICY_GROUPS.smart.tag,
        interrupt_exist_connections: false
      },
      {
        type: "selector",
        tag: ROUTE_POLICY_GROUPS.ai.tag,
        outbounds: [
          ROUTE_POLICY_GROUPS.aiStable.tag,
          ROUTE_POLICY_GROUPS.proxy.tag,
          ...selectorGroups,
          ...tags
        ],
        default: ROUTE_POLICY_GROUPS.aiStable.tag,
        interrupt_exist_connections: false
      },
      { type: "direct", tag: "direct" }
    ],
    route: {
      rules: [
        { action: "sniff" },
        {
          type: "logical",
          mode: "or",
          rules: [
            { protocol: "dns" },
            { port: 53 }
          ],
          action: "hijack-dns"
        },
        {
          ip_is_private: true,
          action: "route",
          outbound: ROUTE_POLICY_GROUPS.direct.tag
        },
        {
          domain: ["localhost"],
          domain_suffix: [...LOCAL_DOMAIN_SUFFIXES],
          action: "resolve",
          server: "dns-local",
          disable_optimistic_cache: true
        },
        {
          domain: ["localhost"],
          domain_suffix: [...LOCAL_DOMAIN_SUFFIXES],
          action: "route",
          outbound: ROUTE_POLICY_GROUPS.direct.tag
        },
        ...customRouteRules,
        ...managedRouteRules
      ],
      rule_set: ruleSets,
      final: routePolicy.mode === "direct"
        ? ROUTE_POLICY_GROUPS.direct.tag
        : ROUTE_POLICY_GROUPS.proxy.tag,
      default_domain_resolver: "dns-local",
      auto_detect_interface: true
    },
    experimental: {
      cache_file: {
        enabled: true,
        store_dns: true
      }
    }
  };
}

function applyServerUsers(inbound, type, users, masterPassword) {
  if (type === "shadowsocks") {
    inbound.network = "tcp";
    inbound.method = "2022-blake3-aes-128-gcm";
    inbound.password = masterPassword;
    inbound.users = users.map((user) => ({ name: user.email, password: user.runtimePassword }));
  } else if (["socks", "http", "mixed", "naive"].includes(type)) {
    inbound.users = users.map((user) => ({ username: user.email, password: user.runtimePassword }));
  } else if (["vmess", "vless"].includes(type)) {
    inbound.users = users.map((user) => ({ name: user.email, uuid: user.runtimeUuid }));
  } else if (type === "tuic") {
    inbound.users = users.map((user) => ({
      name: user.email,
      uuid: user.runtimeUuid,
      password: user.runtimePassword
    }));
  } else if (type === "hysteria") {
    inbound.users = users.map((user) => ({ name: user.email, auth_str: user.runtimePassword }));
  } else if (["trojan", "anytls", "hysteria2", "shadowtls"].includes(type)) {
    inbound.users = users.map((user) => ({ name: user.email, password: user.runtimePassword }));
  }
}

function buildClientOutbound(profile, credential, server, tag = `raylink-${profile.type}`) {
  const common = { type: profile.type, tag, server, server_port: profile.port };
  if (profile.type === "shadowsocks") {
    return {
      ...common,
      network: "tcp",
      method: "2022-blake3-aes-128-gcm",
      password: `${credential.serverPassword}:${credential.runtimePassword}`
    };
  }
  if (profile.type === "socks") {
    return { ...common, username: credential.email, password: credential.runtimePassword };
  }
  if (["http", "mixed"].includes(profile.type)) {
    return addClientTls({ ...common, type: "http", username: credential.email, password: credential.runtimePassword }, profile);
  }
  if (profile.type === "naive") {
    return addClientTls({ ...common, username: credential.email, password: credential.runtimePassword }, profile);
  }
  if (profile.type === "vmess") {
    return addClientTransport(addClientTls({
      ...common,
      uuid: credential.runtimeUuid,
      security: "auto"
    }, profile), profile);
  }
  if (profile.type === "vless") {
    return addClientTransport(addClientTls({ ...common, uuid: credential.runtimeUuid }, profile), profile);
  }
  if (profile.type === "tuic") {
    return addClientTls({
      ...common,
      uuid: credential.runtimeUuid,
      password: credential.runtimePassword,
      congestion_control: "bbr"
    }, profile);
  }
  if (profile.type === "hysteria") {
    return addClientTls({
      ...common,
      auth_str: credential.runtimePassword,
      up_mbps: profile.options.up_mbps,
      down_mbps: profile.options.down_mbps
    }, profile);
  }
  if (["trojan", "anytls", "hysteria2"].includes(profile.type)) {
    return addClientTransport(addClientTls({ ...common, password: credential.runtimePassword }, profile), profile);
  }
  throw protocolError("CLIENT_PROTOCOL_UNSUPPORTED", `${profile.type} 无法生成用户客户端配置`, 409);
}

function buildServerTls(profile, runtimeVersion) {
  if (profile.tls.mode === "none") return null;
  if (profile.tls.mode === "certificate") {
    return {
      enabled: true,
      server_name: profile.tls.serverName || undefined,
      certificate_path: profile.tls.certificatePath,
      key_path: profile.tls.keyPath
    };
  }
  if (profile.tls.mode === "acme") {
    const useCertificateProvider = /^1\.14\./.test(runtimeVersion);
    return {
      enabled: true,
      server_name: profile.tls.serverName,
      // Unknown/legacy Hosts keep the 1.13 syntax during rolling upgrades.
      [useCertificateProvider ? "certificate_provider" : "acme"]: {
        ...(useCertificateProvider ? { type: "acme" } : {}),
        domain: [profile.tls.serverName],
        default_server_name: profile.tls.serverName,
        email: profile.tls.acmeEmail,
        data_directory: profile.tls.acmeDataDirectory,
        disable_tls_alpn_challenge: true
      }
    };
  }
  return {
    enabled: true,
    server_name: profile.tls.serverName,
    reality: {
      enabled: true,
      handshake: {
        server: profile.tls.handshakeServer,
        server_port: profile.tls.handshakePort
      },
      private_key: profile.tls.privateKey,
      short_id: [profile.tls.shortId]
    }
  };
}

function addClientTls(outbound, profile) {
  if (profile.tls.mode === "none") return outbound;
  if (profile.tls.mode === "certificate" || profile.tls.mode === "acme") {
    outbound.tls = {
      enabled: true,
      server_name: profile.tls.serverName
    };
  } else {
    outbound.tls = {
      enabled: true,
      server_name: profile.tls.serverName,
      reality: {
        enabled: true,
        public_key: profile.tls.publicKey,
        short_id: profile.tls.shortId
      },
      utls: {
        enabled: true,
        fingerprint: "chrome"
      }
    };
  }
  if (profile.type === "tuic") outbound.tls.alpn = ["h3"];
  return outbound;
}

function buildTransport(profile) {
  if (profile.transport.type === "none") return null;
  if (profile.transport.type === "quic") return { type: "quic" };
  if (profile.transport.type === "grpc") {
    return {
      type: "grpc",
      ...(profile.transport.serviceName ? { service_name: profile.transport.serviceName } : {})
    };
  }
  return {
    type: profile.transport.type,
    ...(profile.transport.path ? { path: profile.transport.path } : {})
  };
}

function addClientTransport(outbound, profile) {
  const transport = buildTransport(profile);
  if (transport) outbound.transport = transport;
  return outbound;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeProtocolOptions(type, value) {
  const options = isPlainObject(value) ? value : {};
  const reservedFields = ["type", "tag", "listen", "listen_port", "users", "tls", "transport"];
  const reservedField = reservedFields.find((field) => Object.hasOwn(options, field));
  if (reservedField) {
    throw protocolError("PROTOCOL_OPTION_RESERVED", `附加 JSON 不能覆盖受管字段 ${reservedField}`);
  }
  if (type !== "hysteria") return options;
  const upMbps = Number(options.up_mbps || 100);
  const downMbps = Number(options.down_mbps || 100);
  if (!Number.isFinite(upMbps) || upMbps <= 0 || !Number.isFinite(downMbps) || downMbps <= 0) {
    throw protocolError("HYSTERIA_BANDWIDTH_REQUIRED", "Hysteria 上下行速率必须大于 0 Mbps");
  }
  return {
    ...options,
    up_mbps: upMbps,
    down_mbps: downMbps
  };
}

function protocolError(code, message, statusCode = 422) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
