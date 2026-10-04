import { BlockList, isIP } from "node:net";

export const ROUTE_POLICY_GROUPS = Object.freeze({
  proxy: Object.freeze({ tag: "raylink-auto", name: "RayLink 代理" }),
  ai: Object.freeze({ tag: "raylink-ai", name: "AI 网站代理" }),
  aiStable: Object.freeze({ tag: "raylink-ai-stable", name: "AI 稳定出口" }),
  aiManual: Object.freeze({ tag: "raylink-ai-manual", name: "AI 节点选择" }),
  smart: Object.freeze({ tag: "raylink-smart", name: "RayLink 智能" }),
  tcp: Object.freeze({ tag: "raylink-tcp", name: "TCP 稳定" }),
  udp: Object.freeze({ tag: "raylink-udp", name: "UDP 高速" }),
  fallback: Object.freeze({ tag: "raylink-fallback", name: "故障回退" }),
  manual: Object.freeze({ tag: "raylink-manual", name: "手动选择" }),
  direct: Object.freeze({ tag: "direct", name: "DIRECT" })
});

export const DEFAULT_ROUTE_PROBE_URL = "https://www.gstatic.com/generate_204";

export const AI_DOMAIN_SUFFIXES = Object.freeze([
  "openai.com",
  "chatgpt.com",
  "oaistatic.com",
  "oaiusercontent.com",
  "oaistatsig.com",
  "anthropic.com",
  "claude.ai",
  "claude.com",
  "claudeusercontent.com",
  "perplexity.ai",
  "poe.com",
  "x.ai",
  "grok.com",
  "githubcopilot.com",
  "openrouter.ai",
  "mistral.ai",
  "cohere.com",
  // Turnstile verification uses hosts within this dedicated challenge subtree.
  "challenges.cloudflare.com",
  "gemini.google.com",
  "generativelanguage.googleapis.com"
]);

// Login, challenge and asset dependencies must follow the selected AI exit too.
// Keep shared-provider entries exact; the dedicated Turnstile subtree is above.
// Sources: https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps
//          https://code.claude.com/docs/en/network-config
// Service coverage and shared-domain boundaries: docs/ai-service-routing.md
export const AI_DOMAIN_NAMES = Object.freeze([
  "cdn.openaimerge.com",
  "cdn.workos.com",
  "forwarder.workos.com",
  "setup.workos.com",
  "images.workoscdn.com",
  "workos.imgix.net",
  "aistudio.google.com",
  "notebooklm.google.com",
  "copilot.microsoft.com",
  "copilot.cloud.microsoft",
  "copilot-proxy.githubusercontent.com",
  "origin-tracker.githubusercontent.com"
]);

// Explicit overseas services precede geographic inference; keep AI exceptions first.
export const PROXY_DOMAIN_SUFFIXES = Object.freeze([
  "google.com", "googleapis.com", "gstatic.com", "youtube.com", "youtu.be",
  "googlevideo.com", "ytimg.com", "github.com", "githubusercontent.com",
  "githubassets.com", "wikipedia.org", "wikimedia.org", "twitter.com", "x.com",
  "t.co", "twimg.com", "telegram.org", "t.me"
]);

export const CHINA_FALLBACK_DOMAIN_SUFFIXES = Object.freeze([
  ".cn",
  "126.com",
  "163.com",
  "alipay.com",
  "aliyun.com",
  "baidu.com",
  "bilibili.com",
  "bytedance.com",
  "douyin.com",
  "huawei.com",
  "jd.com",
  "mi.com",
  "qq.com",
  "taobao.com",
  "tmall.com",
  "toutiao.com",
  "weibo.com",
  "xiaomi.com",
  "zhihu.com"
]);

export const LOCAL_DOMAIN_SUFFIXES = Object.freeze([
  "local",
  "lan",
  "home.arpa"
]);

export const PRIVATE_NETWORK_CIDRS = Object.freeze([
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10"
]);

const ROUTING_MODES = new Set(["smart", "global-proxy", "direct"]);
const ROUTING_MATCH_TYPES = new Set(["domain", "domain_suffix", "ip", "ip_cidr"]);
const ROUTING_ACTIONS = new Set(["direct", "proxy", "ai", "block"]);
const ROUTING_DNS_POLICIES = new Set(["auto", "domestic", "remote", "system"]);
const MAX_ROUTING_RULES = 500;

export const DEFAULT_ROUTING_POLICY = Object.freeze({
  mode: "smart",
  unknownDomain: "resolve-geoip",
  rules: Object.freeze([])
});

function routingError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 422;
  return error;
}

function normalizeDomain(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/^\.+|\.+$/g, "");
  if (
    !normalized
    || normalized.length > 253
    || (!normalized.includes(".") && normalized !== "localhost")
    || normalized.split(".").some((label) => (
      !label
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ))
  ) {
    throw routingError("INVALID_ROUTING_RULE", "域名规则格式不正确");
  }
  return normalized;
}

function normalizeIpCidr(value) {
  const normalized = String(value || "").trim();
  const [address, prefixText, extra] = normalized.split("/");
  const family = isIP(address);
  const prefix = Number(prefixText);
  if (
    extra !== undefined
    || !family
    || prefixText === undefined
    || !Number.isInteger(prefix)
    || prefix < 0
    || prefix > (family === 4 ? 32 : 128)
  ) {
    throw routingError("INVALID_ROUTING_RULE", "IP CIDR 规则格式不正确");
  }
  return `${address}/${prefix}`;
}

function automaticDnsForAction(action) {
  if (action === "direct") return "domestic";
  if (action === "block") return "system";
  return "remote";
}

function normalizeRule(input, index) {
  const match = String(input?.match || "");
  const action = String(input?.action || "");
  const requestedDns = String(input?.dns || "auto");
  if (!ROUTING_MATCH_TYPES.has(match) || !ROUTING_ACTIONS.has(action)) {
    throw routingError("INVALID_ROUTING_RULE", "路由规则的匹配类型或动作不正确");
  }
  if (!ROUTING_DNS_POLICIES.has(requestedDns)) {
    throw routingError("INVALID_ROUTING_RULE", "路由规则的 DNS 策略不正确");
  }
  let value;
  if (["domain", "domain_suffix"].includes(match)) {
    value = normalizeDomain(input.value);
  } else if (match === "ip") {
    value = String(input.value || "").trim();
    if (!isIP(value)) {
      throw routingError("INVALID_ROUTING_RULE", "IP 规则格式不正确");
    }
  } else {
    value = normalizeIpCidr(input.value);
  }
  const priority = input.priority === undefined ? (index + 1) * 10 : Number(input.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 100_000) {
    throw routingError("INVALID_ROUTING_RULE", "路由规则优先级必须是 0–100000 的整数");
  }
  const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(input.id || ""))
    ? String(input.id)
    : `rule-${index + 1}`;
  return Object.freeze({
    id,
    match,
    value,
    action,
    dns: requestedDns === "auto" ? automaticDnsForAction(action) : requestedDns,
    priority,
    enabled: input.enabled !== false,
    note: String(input.note || "").trim().slice(0, 160)
  });
}

export function normalizeRoutingPolicy(input = {}) {
  const mode = String(input?.mode || DEFAULT_ROUTING_POLICY.mode);
  if (!ROUTING_MODES.has(mode)) {
    throw routingError("INVALID_ROUTING_MODE", "路由模式不受支持");
  }
  const sourceRules = input?.rules === undefined ? [] : input.rules;
  if (!Array.isArray(sourceRules) || sourceRules.length > MAX_ROUTING_RULES) {
    throw routingError("INVALID_ROUTING_RULE", `自定义路由规则不能超过 ${MAX_ROUTING_RULES} 条`);
  }
  const rules = sourceRules
    .map(normalizeRule)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    throw routingError("INVALID_ROUTING_RULE", "路由规则 ID 不能重复");
  }
  return Object.freeze({
    mode,
    unknownDomain: "resolve-geoip",
    rules: Object.freeze(rules)
  });
}

function domainMatches(domain, rule) {
  if (rule.match === "domain") return domain === rule.value;
  return rule.match === "domain_suffix"
    && (domain === rule.value || domain.endsWith(`.${rule.value}`));
}

function matchesSuffix(domain, suffix) {
  const normalized = suffix.startsWith(".") ? suffix.slice(1) : suffix;
  return domain === normalized || domain.endsWith(`.${normalized}`);
}

export function routingRuleMatchesIp(rule, address) {
  const family = isIP(address);
  if (!family) return false;
  const [network, prefix] = rule.value.split("/");
  if (isIP(network) !== family) return false;
  const blockList = new BlockList();
  const type = family === 4 ? "ipv4" : "ipv6";
  if (rule.match === "ip") blockList.addAddress(network, type);
  else blockList.addSubnet(network, Number(prefix), type);
  return blockList.check(address, type);
}

export function routingDecisionForDomain(inputPolicy, inputDomain, { addresses } = {}) {
  const policy = normalizeRoutingPolicy(inputPolicy);
  const domain = normalizeDomain(inputDomain);
  if (domain === "localhost" || LOCAL_DOMAIN_SUFFIXES.some((suffix) => matchesSuffix(domain, suffix))) {
    return { action: "direct", source: "local", ruleId: null, dns: "system" };
  }
  const domainDns = () => routingDecisionForDomain({ ...policy, rules: policy.rules.filter((entry) => (
    !["ip", "ip_cidr"].includes(entry.match)
  )) }, domain).dns;
  for (const rule of policy.rules) {
    if (!rule.enabled) continue;
    const needsAddress = ["ip", "ip_cidr"].includes(rule.match);
    if (needsAddress && addresses === undefined) {
      return { action: "resolve", source: "custom-ip", ruleId: rule.id, dns: domainDns() };
    }
    if (needsAddress
      ? addresses.some((address) => routingRuleMatchesIp(rule, typeof address === "string" ? address : address.address))
      : domainMatches(domain, rule)) {
      return { action: rule.action, source: "custom", ruleId: rule.id, dns: needsAddress ? domainDns() : rule.dns };
    }
  }
  if (policy.mode === "direct") {
    return { action: "direct", source: "mode", ruleId: null, dns: "domestic" };
  }
  if (policy.mode === "global-proxy") {
    return { action: "proxy", source: "mode", ruleId: null, dns: "remote" };
  }
  if (AI_DOMAIN_NAMES.includes(domain) || AI_DOMAIN_SUFFIXES.some((suffix) => matchesSuffix(domain, suffix))) {
    return { action: "ai", source: "ai", ruleId: null, dns: "remote" };
  }
  if (PROXY_DOMAIN_SUFFIXES.some((suffix) => matchesSuffix(domain, suffix))) {
    return { action: "proxy", source: "proxy-domain", ruleId: null, dns: "remote" };
  }
  if (CHINA_FALLBACK_DOMAIN_SUFFIXES.some((suffix) => matchesSuffix(domain, suffix))) {
    return { action: "direct", source: "geosite", ruleId: null, dns: "domestic" };
  }
  return { action: "resolve", source: "geoip", ruleId: null, dns: "remote" };
}

function uniqueExisting(members, names) {
  const available = new Set(names);
  return [...new Set(members)].filter((name) => available.has(name));
}

export function createRoutePolicyCandidates({
  names,
  smart = [],
  tcp = [],
  udp = []
}) {
  const all = [...new Set(names)];
  const automatic = uniqueExisting(smart, all);
  const tcpCandidates = uniqueExisting(tcp, all);
  const udpCandidates = uniqueExisting(udp, all);
  const effectiveAutomatic = automatic.length ? automatic : all;
  const adaptiveUdp = udpCandidates.filter((name) => effectiveAutomatic.includes(name));
  // Server-side UDP health says nothing about the client's cellular path.
  // Probe concrete nodes on the client, prefer TCP, and retain UDP for recovery.
  const fallback = [...new Set([...tcpCandidates, ...udpCandidates, ...all])];
  return {
    all,
    automatic: effectiveAutomatic,
    tcp: tcpCandidates,
    udp: udpCandidates,
    adaptiveUdp,
    fallback,
    manual: all,
    policyChoices: [
      ROUTE_POLICY_GROUPS.fallback.name,
      ROUTE_POLICY_GROUPS.smart.name,
      ...(tcpCandidates.length ? [ROUTE_POLICY_GROUPS.tcp.name] : []),
      ...(udpCandidates.length ? [ROUTE_POLICY_GROUPS.udp.name] : []),
      ROUTE_POLICY_GROUPS.manual.name
    ]
  };
}

export function routeProbeUrlFromConfig(config, fallback = DEFAULT_ROUTE_PROBE_URL) {
  const configured = (config?.outbounds || []).find((outbound) => (
    outbound?.type === "urltest"
    && outbound.tag === ROUTE_POLICY_GROUPS.smart.tag
    && typeof outbound.url === "string"
    && outbound.url.trim()
  ))?.url;
  return configured || fallback;
}
