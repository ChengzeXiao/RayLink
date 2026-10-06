import { readFileSync } from "node:fs";
import {
  AI_DOMAIN_NAMES,
  AI_DOMAIN_SUFFIXES,
  CHINA_FALLBACK_DOMAIN_SUFFIXES,
  createRoutePolicyCandidates,
  LOCAL_DOMAIN_SUFFIXES,
  normalizeRoutingPolicy,
  PRIVATE_NETWORK_CIDRS,
  PROXY_DOMAIN_SUFFIXES,
  routeProbeUrlFromConfig,
  ROUTE_POLICY_GROUPS
} from "../routing/policy.js";
import { getBundledRoutingRules } from "../routing/rule-sets/bundled.js";

const chinaFallbackSuffixes = CHINA_FALLBACK_DOMAIN_SUFFIXES.map(suffix => suffix.replace(/^\./, ""));

const bundledRulesVersion = JSON.parse(readFileSync(new URL("../routing/rule-sets/manifest.json", import.meta.url))).version;
const bundledRulesComment = `# 智能分流内置规则版本: ${bundledRulesVersion}\n# 随 RayLink 应用发布更新；单独更新主控 SRS 清单不会刷新此内置基线。\n`;

// sing-box leading-dot suffixes match subdomains only. Preserve that distinction
// when compiling clients whose native suffix rule also includes the apex.
const chinaDomainMatches = getBundledRoutingRules().geosite.flatMap((rule) => [
  ...(rule.domain || []).map((value) => ["domain", value]),
  ...(rule.domain_suffix || []).map((value) => value.startsWith(".")
    ? ["domain_regex", `^.+${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`]
    : ["domain_suffix", value]),
  ...(rule.domain_regex || []).map((value) => ["domain_regex", value])
]);
const chinaIpCidrs = getBundledRoutingRules().geoip.flatMap((rule) => rule.ip_cidr || []);

function mihomoChinaProviders() {
  return {
    "raylink-cn-domain": {
      type: "inline", behavior: "classical", format: "yaml",
      payload: chinaDomainMatches.map(([kind, value]) => `${{
        domain: "DOMAIN", domain_suffix: "DOMAIN-SUFFIX", domain_regex: "DOMAIN-REGEX"
      }[kind]},${value}`)
    },
    "raylink-cn-ip": { type: "inline", behavior: "ipcidr", format: "yaml", payload: chinaIpCidrs }
  };
}

function egernChinaDomains(targetField, target) {
  return chinaDomainMatches.map(([kind, value]) => ({ [kind]: { match: value, [targetField]: target } }));
}

const generatedNodeTypes = new Set([
  "shadowsocks",
  "vmess",
  "vless",
  "trojan",
  "anytls",
  "hysteria",
  "hysteria2",
  "tuic"
]);

const mihomoCompatibleTypes = new Set(generatedNodeTypes);
const egernCompatibleTypes = new Set([
  "shadowsocks",
  "vmess",
  "vless",
  "trojan",
  "anytls",
  "hysteria2",
  "tuic"
]);
const loonCompatibleTypes = new Set([
  "shadowsocks",
  "vmess",
  "vless",
  "trojan",
  "anytls",
  "hysteria2"
]);
const MIHOMO_HEALTH_TIMEOUT_MS = 12000;
const MIHOMO_TUIC_REQUEST_TIMEOUT_MS = 8000;
const ENDPOINT_HOSTS_DNS_TAG = "raylink-endpoint-hosts";

function scalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

function yamlLines(value, indent = 0) {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [`${prefix}[]`];
    return value.flatMap((item) => {
      if (item !== null && typeof item === "object") {
        const lines = yamlLines(item, indent + 2);
        return [`${prefix}- ${lines[0].trimStart()}`, ...lines.slice(1)];
      }
      return [`${prefix}- ${scalar(item)}`];
    });
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (!entries.length) return [`${prefix}{}`];
    return entries.flatMap(([key, item]) => {
      const safeKey = /^[A-Za-z0-9_-]+$/.test(key) ? key : scalar(key);
      if (item !== null && typeof item === "object") {
        const lines = yamlLines(item, indent + 2);
        return [`${prefix}${safeKey}:`, ...lines];
      }
      return [`${prefix}${safeKey}: ${scalar(item)}`];
    });
  }
  return [`${prefix}${scalar(value)}`];
}

export function stringifyYaml(value) {
  return `${yamlLines(value).join("\n")}\n`;
}

function nodeOutbounds(config) {
  return (config?.outbounds || []).filter((outbound) => generatedNodeTypes.has(outbound.type));
}

function normalizedEndpointOverrides(endpointOverrides) {
  return Object.fromEntries(
    Object.entries(endpointOverrides || {}).filter(([hostname, address]) => (
      hostname && address && hostname !== address
    ))
  );
}

function mapPinnedNodeOutbounds(singBoxConfig, pinnedEndpoints, transform) {
  return (singBoxConfig?.outbounds || []).map((outbound) => {
    const address = generatedNodeTypes.has(outbound.type)
      ? pinnedEndpoints[outbound.server]
      : null;
    return address ? transform(outbound, address) : outbound;
  });
}

function configWithDirectDialEndpoints(singBoxConfig, endpointOverrides) {
  const pinnedEndpoints = normalizedEndpointOverrides(endpointOverrides);
  return {
    ...singBoxConfig,
    outbounds: mapPinnedNodeOutbounds(
      singBoxConfig,
      pinnedEndpoints,
      (outbound, address) => ({
        ...outbound,
        server: address,
        ...(outbound.tls?.enabled && !outbound.tls.server_name
          ? { tls: { ...outbound.tls, server_name: outbound.server } }
          : {})
      })
    )
  };
}

function configWithSingBoxEndpointResolver(singBoxConfig, endpointOverrides) {
  const pinnedEndpoints = normalizedEndpointOverrides(endpointOverrides);
  if (!Object.keys(pinnedEndpoints).length) return singBoxConfig;
  const existingDnsServers = (singBoxConfig?.dns?.servers || [])
    .filter((server) => server.tag !== ENDPOINT_HOSTS_DNS_TAG);
  return {
    ...singBoxConfig,
    dns: {
      ...(singBoxConfig?.dns || {}),
      servers: [
        ...existingDnsServers,
        {
          type: "hosts",
          tag: ENDPOINT_HOSTS_DNS_TAG,
          predefined: pinnedEndpoints
        }
      ]
    },
    outbounds: mapPinnedNodeOutbounds(
      singBoxConfig,
      pinnedEndpoints,
      (outbound) => ({ ...outbound, domain_resolver: ENDPOINT_HOSTS_DNS_TAG })
    )
  };
}

function groupMembers(config, tag, fallback = []) {
  const group = (config?.outbounds || []).find((outbound) => outbound.tag === tag);
  return Array.isArray(group?.outbounds) && group.outbounds.length
    ? group.outbounds
    : fallback;
}

function policyTarget(action) {
  if (action === "direct") return "DIRECT";
  if (action === "block") return "REJECT";
  if (action === "ai") return ROUTE_POLICY_GROUPS.ai.name;
  return ROUTE_POLICY_GROUPS.proxy.name;
}

function mihomoRule(rule) {
  const kind = {
    domain: "DOMAIN",
    domain_suffix: "DOMAIN-SUFFIX",
    ip: isIpv6Value(rule.value) ? "IP-CIDR6" : "IP-CIDR",
    ip_cidr: isIpv6Value(rule.value) ? "IP-CIDR6" : "IP-CIDR"
  }[rule.match];
  const value = rule.match === "ip"
    ? `${rule.value}/${isIpv6Value(rule.value) ? 128 : 32}`
    : rule.value;
  return `${kind},${value},${policyTarget(rule.action)}`;
}

function isIpv6Value(value) {
  return String(value).includes(":");
}

function dnsPolicyValue(dns, action) {
  if (dns === "domestic") return ["https://223.5.5.5/dns-query"];
  if (dns === "system") return ["system"];
  return [`https://1.1.1.1/dns-query#${action === "ai" ? ROUTE_POLICY_GROUPS.ai.name : ROUTE_POLICY_GROUPS.proxy.name}`];
}

function mihomoDnsPolicyRules(policy) {
  const rules = {
    localhost: ["system"],
    ...Object.fromEntries(LOCAL_DOMAIN_SUFFIXES.map((suffix) => [
      `+.${suffix}`,
      ["system"]
    ]))
  };
  const priorDomains = [];
  const matchesSuffix = (domain, suffix) => domain === suffix || domain.endsWith(`.${suffix}`);
  const covered = (domain) => priorDomains.some((rule) => (
    rule.match === "domain_suffix" && matchesSuffix(domain, rule.value)
  ));
  for (const rule of policy.rules) {
    if (!rule.enabled || !["domain", "domain_suffix"].includes(rule.match)) continue;
    // DNS policy chooses the most specific key, while route rules choose the
    // first match. Omit unreachable child keys and protect local infrastructure.
    if (rule.value === "localhost" || LOCAL_DOMAIN_SUFFIXES.some((suffix) => matchesSuffix(rule.value, suffix)) || covered(rule.value)) continue;
    // Mihomo nameserver-policy uses a bare hostname for exact matches.
    // A "domain:" prefix is accepted as a literal key but never matches DNS queries.
    const key = rule.match === "domain" ? rule.value : `+.${rule.value}`;
    // Routing uses the first matching rule; duplicate DNS keys must do the same.
    if (!Object.hasOwn(rules, key)) rules[key] = dnsPolicyValue(rule.dns, rule.action);
    priorDomains.push(rule);
  }
  if (policy.mode === "smart") {
    for (const domain of AI_DOMAIN_NAMES) {
      const key = domain;
      if (!Object.hasOwn(rules, key) && !covered(domain)) rules[key] = dnsPolicyValue("remote", "ai");
    }
    for (const domain of AI_DOMAIN_SUFFIXES) {
      const key = `+.${domain}`;
      if (!Object.hasOwn(rules, key) && !covered(domain)) rules[key] = dnsPolicyValue("remote", "ai");
    }
    for (const domain of PROXY_DOMAIN_SUFFIXES) {
      const key = `+.${domain}`;
      if (!Object.hasOwn(rules, key) && !covered(domain)) rules[key] = dnsPolicyValue("remote", "proxy");
    }
    for (const domain of chinaFallbackSuffixes) {
      const key = `+.${domain}`;
      if (!Object.hasOwn(rules, key) && !covered(domain)) rules[key] = dnsPolicyValue("domestic", "direct");
    }
  }
  return rules;
}

function mihomoLocalBypassRules() {
  return [
    "DOMAIN,localhost,DIRECT",
    ...LOCAL_DOMAIN_SUFFIXES.map((suffix) => `DOMAIN-SUFFIX,${suffix},DIRECT`),
    ...mihomoPrivateIpRules()
  ];
}

function mihomoPrivateIpRules({ resolveDomains = false } = {}) {
  return PRIVATE_NETWORK_CIDRS.map((cidr) => (
    `${isIpv6Value(cidr) ? "IP-CIDR6" : "IP-CIDR"},${cidr},DIRECT${resolveDomains ? "" : ",no-resolve"}`
  ));
}

function egernCustomRule(rule) {
  const match = rule.match === "domain_suffix"
    ? "domain_suffix"
    : rule.match === "domain"
      ? "domain"
      : isIpv6Value(rule.value) ? "ip_cidr6" : "ip_cidr";
  const value = rule.match === "ip"
    ? `${rule.value}/${isIpv6Value(rule.value) ? 128 : 32}`
    : rule.value;
  return {
    [match]: {
      match: value,
      policy: policyTarget(rule.action)
    }
  };
}

function egernPrivateIpRules({ resolveDomains = false } = {}) {
  return PRIVATE_NETWORK_CIDRS.map((cidr) => ({
    [isIpv6Value(cidr) ? "ip_cidr6" : "ip_cidr"]: {
      match: cidr, policy: "DIRECT", ...(resolveDomains ? {} : { no_resolve: true })
    }
  }));
}

function egernLocalBypassRules() {
  return [
    { domain: { match: "localhost", policy: "DIRECT" } },
    ...LOCAL_DOMAIN_SUFFIXES.map((suffix) => ({
      domain_suffix: { match: suffix, policy: "DIRECT" }
    })),
    ...egernPrivateIpRules()
  ];
}

function applyMihomoTls(proxy, outbound) {
  if (!outbound.tls?.enabled) return proxy;
  proxy.tls = true;
  if (outbound.tls.server_name) {
    const serverNameField = ["vmess", "vless"].includes(outbound.type)
      ? "servername"
      : "sni";
    proxy[serverNameField] = outbound.tls.server_name;
  }
  proxy["skip-cert-verify"] = false;
  if (outbound.tls.reality?.enabled) {
    proxy["reality-opts"] = {
      "public-key": outbound.tls.reality.public_key,
      "short-id": outbound.tls.reality.short_id || ""
    };
    proxy["client-fingerprint"] = outbound.tls.utls?.fingerprint || "chrome";
  }
  return proxy;
}

function applyMihomoTransport(proxy, outbound) {
  const transport = outbound.transport;
  if (!transport) return proxy;
  const type = transport.type === "httpupgrade" ? "httpupgrade" : transport.type;
  proxy.network = type;
  if (type === "ws") {
    proxy["ws-opts"] = {
      path: transport.path || "/"
    };
  } else if (type === "grpc") {
    proxy["grpc-opts"] = {
      "grpc-service-name": transport.service_name || ""
    };
  } else if (type === "http") {
    proxy["http-opts"] = {
      path: [transport.path || "/"]
    };
  } else if (type === "httpupgrade") {
    proxy["http-upgrade-opts"] = {
      path: transport.path || "/"
    };
  }
  return proxy;
}

function mihomoProxy(outbound) {
  const common = {
    name: outbound.tag,
    type: outbound.type === "shadowsocks" ? "ss" : outbound.type,
    server: outbound.server,
    port: outbound.server_port
  };
  if (outbound.type === "shadowsocks") {
    return {
      ...common,
      cipher: outbound.method,
      password: outbound.password,
      udp: outbound.network !== "tcp"
    };
  }
  if (outbound.type === "vmess") {
    return applyMihomoTransport(applyMihomoTls({
      ...common,
      uuid: outbound.uuid,
      alterId: 0,
      cipher: outbound.security || "auto",
      udp: true
    }, outbound), outbound);
  }
  if (outbound.type === "vless") {
    return applyMihomoTransport(applyMihomoTls({
      ...common,
      uuid: outbound.uuid,
      ...(outbound.flow ? { flow: outbound.flow } : {}),
      udp: true
    }, outbound), outbound);
  }
  if (outbound.type === "tuic") {
    const alpn = Array.isArray(outbound.tls?.alpn) && outbound.tls.alpn.length
      ? outbound.tls.alpn
      : null;
    return applyMihomoTls({
      ...common,
      uuid: outbound.uuid,
      password: outbound.password,
      "congestion-controller": outbound.congestion_control || "bbr",
      "udp-relay-mode": "native",
      "heartbeat-interval": 10000,
      "request-timeout": MIHOMO_TUIC_REQUEST_TIMEOUT_MS,
      ...(alpn ? { alpn } : {}),
      udp: true
    }, outbound);
  }
  if (outbound.type === "hysteria") {
    return applyMihomoTls({
      ...common,
      "auth-str": outbound.auth_str,
      up: `${outbound.up_mbps || 100} Mbps`,
      down: `${outbound.down_mbps || 100} Mbps`,
      udp: true
    }, outbound);
  }
  if (outbound.type === "hysteria2") {
    return applyMihomoTls({
      ...common,
      password: outbound.password,
      udp: true
    }, outbound);
  }
  return applyMihomoTransport(applyMihomoTls({
    ...common,
    password: outbound.password,
    udp: true
  }, outbound), outbound);
}

function loonQuote(value) {
  return JSON.stringify(String(value));
}

function loonTlsOptions(outbound, { reality = false } = {}) {
  if (!outbound.tls?.enabled) return [];
  const serverName = outbound.tls.server_name || outbound.server;
  if (reality && outbound.tls.reality?.enabled) {
    return [
      `sni=${serverName}`,
      `public-key=${loonQuote(outbound.tls.reality.public_key)}`,
      `short-id=${outbound.tls.reality.short_id || ""}`
    ];
  }
  return [
    `sni=${serverName}`,
    "skip-cert-verify=false"
  ];
}

function loonTransportOptions(outbound) {
  const transport = outbound.transport;
  if (!transport || transport.type === "tcp") return ["transport=tcp"];
  if (!["ws", "http"].includes(transport.type)) return null;
  return [
    `transport=${transport.type}`,
    ...(transport.path ? [`path=${transport.path}`] : []),
    ...(transport.host ? [`host=${transport.host}`] : [])
  ];
}

function loonProxy(outbound) {
  const prefix = `${outbound.tag}=`;
  const common = `${outbound.server},${outbound.server_port}`;
  if (outbound.type === "shadowsocks") {
    return `${prefix}shadowsocks,${common},${outbound.method},${loonQuote(outbound.password)},udp=${outbound.network !== "tcp"}`;
  }
  if (["vmess", "vless"].includes(outbound.type)) {
    const transport = loonTransportOptions(outbound);
    if (!transport) return null;
    const reality = Boolean(outbound.tls?.reality?.enabled);
    const options = [
      "udp=true",
      ...transport,
      ...(outbound.tls?.enabled ? ["over-tls=true"] : []),
      ...(outbound.flow ? [`flow=${outbound.flow}`] : []),
      ...loonTlsOptions(outbound, { reality })
    ];
    const credentials = outbound.type === "vmess"
      ? `${outbound.security || "auto"},${loonQuote(outbound.uuid)}`
      : loonQuote(outbound.uuid);
    return `${prefix}${outbound.type},${common},${credentials},${options.join(",")}`;
  }
  if (["trojan", "anytls"].includes(outbound.type)) {
    if (outbound.type === "anytls" && outbound.transport && outbound.transport.type !== "tcp") {
      return null;
    }
    if (outbound.transport && !["tcp", "ws"].includes(outbound.transport.type)) return null;
    const options = [
      ...(outbound.transport?.type === "ws"
        ? [
            "transport=ws",
            ...(outbound.transport.path ? [`path=${outbound.transport.path}`] : []),
            ...(outbound.transport.host ? [`host=${outbound.transport.host}`] : [])
          ]
        : []),
      ...loonTlsOptions(outbound, { reality: Boolean(outbound.tls?.reality?.enabled) }),
      "udp=true"
    ];
    return `${prefix}${outbound.type},${common},${loonQuote(outbound.password)},${options.join(",")}`;
  }
  if (outbound.type === "hysteria2") {
    const options = [
      ...loonTlsOptions(outbound),
      "udp=true"
    ];
    return `${prefix}Hysteria2,${common},${loonQuote(outbound.password)},${options.join(",")}`;
  }
  return null;
}

function buildLoonNodes(singBoxConfig) {
  const nodes = nodeOutbounds(singBoxConfig)
    .filter((outbound) => loonCompatibleTypes.has(outbound.type))
    .map(loonProxy)
    .filter(Boolean);
  if (!nodes.length) throw subscriptionError("NO_COMPATIBLE_NODES", "当前没有 Loon 可用节点");
  return `${nodes.join("\n")}\n`;
}

function buildMihomoConfig(singBoxConfig, inputPolicy, endpointOverrides = {}, sharedHealthChecks = false) {
  const routePolicy = normalizeRoutingPolicy(inputPolicy);
  const proxies = nodeOutbounds(singBoxConfig)
    .filter((outbound) => mihomoCompatibleTypes.has(outbound.type))
    .map(mihomoProxy);
  if (!proxies.length) throw subscriptionError("NO_COMPATIBLE_NODES", "当前没有 Mihomo 可用节点");
  const names = proxies.map((proxy) => proxy.name);
  const candidates = createRoutePolicyCandidates({
    names,
    smart: groupMembers(singBoxConfig, ROUTE_POLICY_GROUPS.smart.tag, names),
    tcp: groupMembers(singBoxConfig, ROUTE_POLICY_GROUPS.tcp.tag),
    udp: groupMembers(singBoxConfig, ROUTE_POLICY_GROUPS.udp.tag)
  });
  const {
    automatic,
    tcp,
    udp,
    fallback: fallbackGroups,
    manual: manualCandidates,
    policyChoices
  } = candidates;
  // The compiler carries Host membership through this native group's concrete
  // members. Never infer a Host from a display name or a tag prefix.
  const aiPinned = routePolicy.aiExit.mode === "pinned";
  const aiNames = aiPinned ? groupMembers(singBoxConfig, ROUTE_POLICY_GROUPS.aiStable.tag)
    .filter((name) => names.includes(name)) : names;
  const aiFallback = aiPinned ? aiNames : fallbackGroups;
  const aiUnavailable = aiPinned && !aiNames.length;
  const aiManual = routePolicy.aiSelection === "manual";
  const probeUrl = routeProbeUrlFromConfig(singBoxConfig);
  const proxyGroups = [
    {
      name: ROUTE_POLICY_GROUPS.proxy.name,
      type: "select",
      proxies: policyChoices
    },
    ...(routePolicy.mode === "smart" ? [{
      name: ROUTE_POLICY_GROUPS.unknown.name,
      type: "select",
      proxies: [ROUTE_POLICY_GROUPS.proxy.name, ROUTE_POLICY_GROUPS.direct.name]
    }] : []),
    {
      name: ROUTE_POLICY_GROUPS.ai.name,
      type: "select",
      proxies: aiManual ? (aiNames.length ? aiNames : ["REJECT"]) : [ROUTE_POLICY_GROUPS.aiStable.name,
        ...(sharedHealthChecks ? [ROUTE_POLICY_GROUPS.aiManual.name] : aiNames),
        ...(aiPinned ? [] : policyChoices)]
    },
    // Mihomo prepends provider nodes before explicit group proxies. Keep the
    // automatic top-level AI selector free of `use`, or it defaults to an
    // individual node and bypasses recovery. Manual mode intentionally exposes
    // only concrete nodes and does not need this extra child selector.
    ...(sharedHealthChecks && !aiManual ? [{
      name: ROUTE_POLICY_GROUPS.aiManual.name,
      type: "select",
      proxies: aiNames.length ? aiNames : ["REJECT"]
    }] : []),
    {
      name: ROUTE_POLICY_GROUPS.smart.name,
      type: "url-test",
      proxies: automatic,
      url: probeUrl,
      interval: 180,
      tolerance: 80,
      lazy: false,
      timeout: MIHOMO_HEALTH_TIMEOUT_MS,
      "max-failed-times": 3,
      "expected-status": 204
    },
    ...(tcp.length ? [{
      name: ROUTE_POLICY_GROUPS.tcp.name,
      type: "url-test",
      proxies: tcp,
      url: probeUrl,
      interval: 180,
      tolerance: 50,
      lazy: false,
      timeout: MIHOMO_HEALTH_TIMEOUT_MS,
      "max-failed-times": 3,
      "expected-status": 204
    }] : []),
    ...(udp.length ? [{
      name: ROUTE_POLICY_GROUPS.udp.name,
      type: "url-test",
      proxies: udp,
      url: probeUrl,
      interval: 180,
      tolerance: 80,
      lazy: false,
      timeout: MIHOMO_HEALTH_TIMEOUT_MS,
      "max-failed-times": 3,
      "expected-status": 204
    }] : []),
    {
      name: ROUTE_POLICY_GROUPS.fallback.name,
      type: "fallback",
      proxies: fallbackGroups,
      url: probeUrl,
      interval: 60,
      lazy: false,
      timeout: MIHOMO_HEALTH_TIMEOUT_MS,
      "max-failed-times": 3,
      "expected-status": 204
    },
    {
      name: ROUTE_POLICY_GROUPS.aiStable.name,
      type: aiUnavailable ? "select" : "fallback",
      proxies: aiUnavailable ? ["REJECT"] : aiFallback,
      ...(!aiUnavailable ? {
        url: probeUrl,
        interval: 60,
        lazy: false,
        timeout: MIHOMO_HEALTH_TIMEOUT_MS,
        "max-failed-times": 3,
        "expected-status": 204
      } : {})
    },
    {
      name: ROUTE_POLICY_GROUPS.manual.name,
      type: "select",
      proxies: manualCandidates
    }
  ];
  const providerName = "raylink-health";
  const sharedGroups = sharedHealthChecks ? proxyGroups.map((group) => {
    const nodeNames = group.proxies.filter((name) => names.includes(name));
    if (!nodeNames.length) return group;
    const groupNames = group.proxies.filter((name) => !names.includes(name));
    const { proxies: ignored, ...sharedGroup } = group;
    return {
      ...sharedGroup,
      ...(groupNames.length ? { proxies: groupNames } : {}),
      use: [providerName],
      // Mihomo's ordered filters preserve fallback priority as well as exact
      // membership. Encode its delimiter if it occurs in a node's literal name.
      filter: nodeNames.map((name) => `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("`", "\\x60")}$`).join("`")
    };
  }) : proxyGroups;
  const pinnedEndpoints = normalizedEndpointOverrides(endpointOverrides);
  const pinnedHostnames = Object.keys(pinnedEndpoints);
  return {
    "mixed-port": 7890,
    "allow-lan": false,
    mode: "rule",
    "log-level": "info",
    ipv6: false,
    "unified-delay": true,
    "tcp-concurrent": true,
    profile: {
      "store-selected": true,
      "store-fake-ip": true
    },
    ...(pinnedHostnames.length ? { hosts: pinnedEndpoints } : {}),
    dns: {
      enable: true,
      ipv6: false,
      ...(pinnedHostnames.length ? { "use-hosts": true } : {}),
      "enhanced-mode": "fake-ip",
      "fake-ip-range": "198.18.0.1/16",
      "fake-ip-filter": [...new Set([
        ...pinnedHostnames, "localhost", ...LOCAL_DOMAIN_SUFFIXES.map((suffix) => `+.${suffix}`)
      ])],
      "respect-rules": true,
      "default-nameserver": ["223.5.5.5"],
      nameserver: routePolicy.mode === "direct"
        ? ["https://223.5.5.5/dns-query"]
        : [`https://1.1.1.1/dns-query#${ROUTE_POLICY_GROUPS.proxy.name}`],
      "nameserver-policy": {
        ...mihomoDnsPolicyRules(routePolicy),
        ...(routePolicy.mode === "smart"
          ? { "rule-set:raylink-cn-domain": ["https://223.5.5.5/dns-query"] }
          : {})
      },
      "proxy-server-nameserver": [
        "https://223.5.5.5/dns-query"
      ],
      ...(pinnedHostnames.length ? {
        "proxy-server-nameserver-policy": Object.fromEntries(
          pinnedHostnames.map((hostname) => [
            hostname,
            ["https://223.5.5.5/dns-query"]
          ])
        )
      } : {})
    },
    ...(sharedHealthChecks ? {
      "proxy-providers": {
        [providerName]: {
          type: "inline",
          payload: proxies,
          "health-check": {
            enable: true,
            url: probeUrl,
            interval: 60,
            timeout: MIHOMO_HEALTH_TIMEOUT_MS,
            lazy: false,
            "expected-status": 204
          }
        }
      }
    } : { proxies }),
    // In modern exports every automatic group consumes the same provider
    // objects and URL. Only the provider schedules background checks; groups
    // retain selection and failure-triggered recovery with the same budget.
    "proxy-groups": sharedGroups,
    ...(routePolicy.mode === "smart" ? { "rule-providers": mihomoChinaProviders() } : {}),
    rules: [
      ...mihomoLocalBypassRules(),
      ...routePolicy.rules.filter((rule) => rule.enabled).map(mihomoRule),
      ...(routePolicy.mode === "direct"
        ? [...mihomoPrivateIpRules({ resolveDomains: true }), "MATCH,DIRECT"]
        : routePolicy.mode === "global-proxy"
          ? [...mihomoPrivateIpRules({ resolveDomains: true }), `MATCH,${ROUTE_POLICY_GROUPS.proxy.name}`]
          : [
              ...AI_DOMAIN_NAMES.map(
                (domain) => `DOMAIN,${domain},${ROUTE_POLICY_GROUPS.ai.name}`
              ),
              ...AI_DOMAIN_SUFFIXES.map(
                (domain) => `DOMAIN-SUFFIX,${domain},${ROUTE_POLICY_GROUPS.ai.name}`
              ),
              ...PROXY_DOMAIN_SUFFIXES.map(
                (domain) => `DOMAIN-SUFFIX,${domain},${ROUTE_POLICY_GROUPS.proxy.name}`
              ),
              ...chinaFallbackSuffixes.map((domain) => `DOMAIN-SUFFIX,${domain},DIRECT`),
              "RULE-SET,raylink-cn-domain,DIRECT",
              ...mihomoPrivateIpRules({ resolveDomains: true }),
              "RULE-SET,raylink-cn-ip,DIRECT",
              `MATCH,${ROUTE_POLICY_GROUPS.unknown.name}`
            ])
    ]
  };
}

function egernReality(tls) {
  if (!tls?.reality?.enabled) return undefined;
  return {
    public_key: tls.reality.public_key,
    short_id: tls.reality.short_id || ""
  };
}

function egernTransport(outbound) {
  const tls = outbound.tls?.enabled ? outbound.tls : null;
  const reality = egernReality(tls);
  const transport = outbound.transport;
  if (!transport) {
    if (!tls) return undefined;
    return {
      tls: {
        sni: tls.server_name || outbound.server,
        skip_tls_verify: false,
        ...(reality ? { reality } : {})
      }
    };
  }
  if (transport.type === "grpc") {
    return {
      grpc: {
        service_name: transport.service_name || "",
        sni: tls?.server_name || outbound.server,
        skip_tls_verify: false,
        ...(reality ? { reality } : {})
      }
    };
  }
  const type = transport.type === "ws" && tls ? "wss" : transport.type;
  return {
    [type]: {
      ...(transport.path ? { path: transport.path } : {}),
      ...(tls ? {
        sni: tls.server_name || outbound.server,
        skip_tls_verify: false
      } : {}),
      ...(reality ? { reality } : {})
    }
  };
}

function egernProxy(outbound) {
  const common = {
    name: outbound.tag,
    server: outbound.server,
    port: outbound.server_port
  };
  if (outbound.type === "shadowsocks") {
    return {
      shadowsocks: {
        ...common,
        method: outbound.method,
        password: outbound.password,
        udp_relay: outbound.network !== "tcp"
      }
    };
  }
  if (outbound.type === "vmess") {
    return {
      vmess: {
        ...common,
        user_id: outbound.uuid,
        security: outbound.security || "auto",
        legacy: false,
        udp_relay: true,
        ...(egernTransport(outbound) ? { transport: egernTransport(outbound) } : {})
      }
    };
  }
  if (outbound.type === "vless") {
    return {
      vless: {
        ...common,
        user_id: outbound.uuid,
        ...(outbound.flow ? { flow: outbound.flow } : {}),
        udp_relay: true,
        ...(egernTransport(outbound) ? { transport: egernTransport(outbound) } : {})
      }
    };
  }
  if (outbound.type === "hysteria2") {
    return {
      hysteria2: {
        ...common,
        auth: outbound.password,
        sni: outbound.tls?.server_name || outbound.server,
        skip_tls_verify: false
      }
    };
  }
  if (outbound.type === "tuic") {
    const alpn = Array.isArray(outbound.tls?.alpn) && outbound.tls.alpn.length
      ? outbound.tls.alpn
      : null;
    return {
      tuic: {
        ...common,
        uuid: outbound.uuid,
        password: outbound.password,
        udp_relay_mode: "native",
        ...(alpn ? { alpn } : {}),
        sni: outbound.tls?.server_name || outbound.server,
        skip_tls_verify: false
      }
    };
  }
  const reality = egernReality(outbound.tls);
  return {
    [outbound.type]: {
      ...common,
      password: outbound.password,
      sni: outbound.tls?.server_name || outbound.server,
      udp_relay: true,
      skip_tls_verify: false,
      ...(reality ? { reality } : {}),
      ...(outbound.transport ? { transport: egernTransport(outbound) } : {})
    }
  };
}

function egernProxies(singBoxConfig) {
  return nodeOutbounds(singBoxConfig)
    .filter((outbound) => egernCompatibleTypes.has(outbound.type))
    .map(egernProxy);
}

function egernProxyNames(proxies) {
  return proxies.map((entry) => Object.values(entry)[0].name);
}

function buildEgernProfile(singBoxConfig, inputPolicy) {
  const routePolicy = normalizeRoutingPolicy(inputPolicy);
  const proxies = egernProxies(singBoxConfig);
  if (!proxies.length) throw subscriptionError("NO_COMPATIBLE_NODES", "当前没有 Egern 可用节点");
  const names = egernProxyNames(proxies);
  const candidates = createRoutePolicyCandidates({
    names,
    smart: groupMembers(singBoxConfig, ROUTE_POLICY_GROUPS.smart.tag, names),
    tcp: groupMembers(singBoxConfig, ROUTE_POLICY_GROUPS.tcp.tag),
    udp: groupMembers(singBoxConfig, ROUTE_POLICY_GROUPS.udp.tag)
  });
  const smartNames = candidates.automatic;
  const tcp = candidates.tcp;
  const udp = candidates.udp;
  const fallbackGroups = candidates.fallback;
  const aiPinned = routePolicy.aiExit.mode === "pinned";
  const aiNames = aiPinned ? groupMembers(singBoxConfig, ROUTE_POLICY_GROUPS.aiStable.tag)
    .filter((name) => names.includes(name)) : names;
  const aiFallback = aiPinned ? aiNames : fallbackGroups;
  const aiUnavailable = aiPinned && !aiNames.length;
  const aiManual = routePolicy.aiSelection === "manual";
  const probeUrl = routeProbeUrlFromConfig(singBoxConfig);
  const usesAiDns = routePolicy.mode === "smart" || routePolicy.rules.some((rule) => (
    rule.enabled && ["domain", "domain_suffix"].includes(rule.match)
    && rule.action === "ai" && rule.dns === "remote"
  ));
  return {
    ipv6: false,
    close_connections_on_policy_change: false,
    hijack_dns: ["*"],
    bypass_tunnel_proxy: [
      "localhost",
      ...LOCAL_DOMAIN_SUFFIXES.map((suffix) => `*.${suffix}`),
      ...PRIVATE_NETWORK_CIDRS
    ],
    dns: {
      bootstrap: ["system", "223.5.5.5"],
      upstreams: {
        local: ["system"],
        domestic: ["https://223.5.5.5/dns-query"],
        overseas: [
          "https://1.1.1.1/dns-query",
          "https://8.8.8.8/dns-query"
        ],
        ...(usesAiDns ? { ai: ["https://9.9.9.9/dns-query"] } : {})
      },
      forward: [
        {
          domain: {
            match: "localhost",
            value: "local"
          }
        },
        ...LOCAL_DOMAIN_SUFFIXES.map((suffix) => ({
          domain_suffix: {
            match: suffix,
            value: "local"
          }
        })),
        ...routePolicy.rules.flatMap((rule) => {
          if (!rule.enabled || !["domain", "domain_suffix"].includes(rule.match)) return [];
          return [{
            [rule.match]: {
              match: rule.value,
              value: rule.dns === "system" ? "local"
                : rule.dns === "domestic" ? "domestic"
                  : rule.action === "ai" ? "ai" : "overseas"
            }
          }];
        }),
        ...(routePolicy.mode === "smart" ? AI_DOMAIN_NAMES.map((domain) => ({
          domain: { match: domain, value: "ai" }
        })) : []),
        ...(routePolicy.mode === "smart" ? AI_DOMAIN_SUFFIXES.map((domain) => ({
          domain_suffix: { match: domain, value: "ai" }
        })) : []),
        ...(routePolicy.mode === "smart" ? PROXY_DOMAIN_SUFFIXES.map((domain) => ({
          domain_suffix: { match: domain, value: "overseas" }
        })) : []),
        ...(routePolicy.mode === "smart" ? chinaFallbackSuffixes.map((domain) => ({
          domain_suffix: { match: domain, value: "domestic" }
        })) : []),
        ...(routePolicy.mode === "smart" ? egernChinaDomains("value", "domestic") : []),
        {
          domain_wildcard: {
            match: "*",
            value: routePolicy.mode === "direct" ? "domestic" : "overseas"
          }
        }
      ],
      proxy_nameservers: ["https://223.5.5.5/dns-query"],
      skip_tls_verify: false
    },
    proxies,
    policy_groups: [
      {
        smart: {
          name: ROUTE_POLICY_GROUPS.smart.name,
          policies: smartNames,
          priorities: {
            "(?i)SHADOWSOCKS|VLESS|TROJAN|ANYTLS|VMESS": 0.85,
            "(?i)HYSTERIA2|TUIC": 1
          },
          latency_test_url: probeUrl
        }
      },
      ...(tcp.length ? [{
        auto_test: {
          name: ROUTE_POLICY_GROUPS.tcp.name,
          policies: tcp,
          interval: 300,
          tolerance: 100,
          timeout: 5
        }
      }] : []),
      ...(udp.length ? [{
        auto_test: {
          name: ROUTE_POLICY_GROUPS.udp.name,
          policies: udp,
          interval: 300,
          tolerance: 120,
          timeout: 5
        }
      }] : []),
      {
        fallback: {
          name: ROUTE_POLICY_GROUPS.fallback.name,
          policies: fallbackGroups,
          interval: 60,
          timeout: 5,
          latency_test_url: probeUrl
        }
      },
      {
        conditional: {
          name: "网络环境",
          rules: [
            {
              cellular: {
                match: "*",
                policy: ROUTE_POLICY_GROUPS.fallback.name
              }
            },
            { ssid: { match: "*", policy: "故障回退" } }
          ],
          default_policy: ROUTE_POLICY_GROUPS.fallback.name
        }
      },
      {
        select: {
          name: ROUTE_POLICY_GROUPS.proxy.name,
          policies: ["网络环境", ...candidates.policyChoices]
        }
      },
      ...(routePolicy.mode === "smart" ? [{
        select: {
          name: ROUTE_POLICY_GROUPS.unknown.name,
          policies: [ROUTE_POLICY_GROUPS.proxy.name, ROUTE_POLICY_GROUPS.direct.name]
        }
      }] : []),
      {
        [aiUnavailable ? "select" : "fallback"]: {
          name: ROUTE_POLICY_GROUPS.aiStable.name,
          policies: aiUnavailable ? ["REJECT"] : aiFallback,
          ...(!aiUnavailable ? { interval: 60, timeout: 5, latency_test_url: probeUrl } : {})
        }
      },
      {
        select: {
          name: ROUTE_POLICY_GROUPS.ai.name,
          policies: aiManual ? (aiNames.length ? aiNames : ["REJECT"]) : [
            ROUTE_POLICY_GROUPS.aiStable.name,
            ...aiNames,
            ...(!aiPinned ? [
              "网络环境",
              ROUTE_POLICY_GROUPS.fallback.name,
              ROUTE_POLICY_GROUPS.smart.name,
              ...(tcp.length ? [ROUTE_POLICY_GROUPS.tcp.name] : []),
              ...(udp.length ? [ROUTE_POLICY_GROUPS.udp.name] : [])
            ] : [])
          ]
        }
      },
      {
        select: {
          name: ROUTE_POLICY_GROUPS.manual.name,
          policies: [
            "网络环境",
            ROUTE_POLICY_GROUPS.smart.name,
            ...(tcp.length ? [ROUTE_POLICY_GROUPS.tcp.name] : []),
            ...(udp.length ? [ROUTE_POLICY_GROUPS.udp.name] : []),
            ROUTE_POLICY_GROUPS.fallback.name,
            ...names
          ]
        }
      }
    ],
    rules: [
      ...egernLocalBypassRules(),
      ...routePolicy.rules.filter((rule) => rule.enabled).map(egernCustomRule),
      // Default DNS connections follow the AI exit unless explicitly overridden.
      ...(usesAiDns ? [{ ip_cidr: { match: "9.9.9.9/32", policy: ROUTE_POLICY_GROUPS.ai.name, no_resolve: true } }] : []),
      ...(routePolicy.mode === "direct"
        ? [...egernPrivateIpRules({ resolveDomains: true }), { default: { policy: "DIRECT" } }]
        : routePolicy.mode === "global-proxy"
          ? [...egernPrivateIpRules({ resolveDomains: true }), { default: { policy: ROUTE_POLICY_GROUPS.proxy.name } }]
          : [
              ...AI_DOMAIN_NAMES.map((domain) => ({
                domain: { match: domain, policy: ROUTE_POLICY_GROUPS.ai.name }
              })),
              ...AI_DOMAIN_SUFFIXES.map((domain) => ({
                domain_suffix: { match: domain, policy: ROUTE_POLICY_GROUPS.ai.name }
              })),
              ...PROXY_DOMAIN_SUFFIXES.map((domain) => ({
                domain_suffix: { match: domain, policy: ROUTE_POLICY_GROUPS.proxy.name }
              })),
              ...chinaFallbackSuffixes.map((domain) => ({
                domain_suffix: { match: domain, policy: "DIRECT" }
              })),
              ...egernChinaDomains("policy", "DIRECT"),
              ...egernPrivateIpRules({ resolveDomains: true }),
              ...chinaIpCidrs.map((cidr) => ({ [isIpv6Value(cidr) ? "ip_cidr6" : "ip_cidr"]: { match: cidr, policy: "DIRECT" } })),
              { default: { policy: ROUTE_POLICY_GROUPS.unknown.name } }
            ])
    ]
  };
}

export function buildSubscriptionArtifact({
  format,
  singBoxConfig,
  routePolicy,
  endpointOverrides = {}
}) {
  if (format === "singbox") {
    return {
      contentType: "application/json; charset=utf-8",
      filename: "raylink-sing-box.json",
      body: JSON.stringify(configWithSingBoxEndpointResolver(singBoxConfig, endpointOverrides))
    };
  }
  if (format === "mihomo" || format === "mihomo-modern") {
    const sharedHealthChecks = format === "mihomo-modern";
    return {
      contentType: "application/yaml; charset=utf-8",
      filename: sharedHealthChecks ? "raylink-mihomo-modern.yaml" : "raylink-mihomo.yaml",
      body: (sharedHealthChecks ? "# 共享健康检查需要 Mihomo >= 1.19.1；旧客户端请使用 format=mihomo。\n" : "")
        + bundledRulesComment + stringifyYaml(buildMihomoConfig(singBoxConfig, routePolicy, endpointOverrides, sharedHealthChecks))
    };
  }
  if (format === "loon") {
    return {
      contentType: "text/plain; charset=utf-8",
      filename: "raylink-loon.list",
      body: buildLoonNodes(configWithDirectDialEndpoints(singBoxConfig, endpointOverrides))
    };
  }
  if (format === "egern") {
    const proxies = egernProxies(configWithDirectDialEndpoints(singBoxConfig, endpointOverrides));
    if (!proxies.length) throw subscriptionError("NO_COMPATIBLE_NODES", "当前没有 Egern 可用节点");
    return {
      contentType: "application/yaml; charset=utf-8",
      filename: "raylink-egern.yaml",
      body: stringifyYaml({ proxies })
    };
  }
  if (format === "egern-profile") {
    return {
      contentType: "application/yaml; charset=utf-8",
      filename: "raylink-egern-profile.yaml",
      body: bundledRulesComment + stringifyYaml(buildEgernProfile(
        configWithDirectDialEndpoints(singBoxConfig, endpointOverrides),
        routePolicy
      ))
    };
  }
  throw subscriptionError("SUBSCRIPTION_FORMAT_UNSUPPORTED", "订阅格式不受支持", 400);
}

function subscriptionError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export const subscriptionCompatibility = Object.freeze({
  mihomo: [...mihomoCompatibleTypes],
  "mihomo-modern": [...mihomoCompatibleTypes],
  loon: [...loonCompatibleTypes],
  egern: [...egernCompatibleTypes],
  singbox: [...generatedNodeTypes, "naive"]
});
