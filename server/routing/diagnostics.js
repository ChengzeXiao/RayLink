import { lookup as nodeLookup } from "node:dns/promises";

import {
  normalizeRoutingPolicy,
  PRIVATE_NETWORK_CIDRS,
  routingDecisionForDomain,
  routingRuleMatchesIp,
  ROUTE_POLICY_GROUPS
} from "./policy.js";

const MAX_DIAGNOSTIC_ADDRESSES = 16;
const MAX_PENDING_LOOKUPS = 4;
const pendingLookups = new WeakMap();

function sharedLookup(lookup, domain) {
  let pending = pendingLookups.get(lookup);
  if (!pending) { pending = new Map(); pendingLookups.set(lookup, pending); }
  if (pending.has(domain)) return pending.get(domain);
  if (pending.size >= MAX_PENDING_LOOKUPS) {
    const error = new Error("主控 DNS 诊断繁忙，请稍后重试");
    error.code = "DOMAIN_RESOLUTION_BUSY";
    error.statusCode = 503;
    error.retryable = true;
    throw error;
  }
  // dns.lookup/getaddrinfo cannot be cancelled. Retain its single-flight entry
  // after caller timeouts, and bound native work rather than merely waiters.
  const result = Promise.resolve().then(() => lookup(domain, { all: true, verbatim: true }))
    .finally(() => pending.delete(domain));
  pending.set(domain, result);
  return result;
}

async function lookupWithDeadline(lookup, domain, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      sharedLookup(lookup, domain),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("域名解析超时，请稍后重试或检查主控 DNS 状态");
          error.code = "DOMAIN_RESOLUTION_TIMEOUT";
          error.statusCode = 504;
          error.retryable = true;
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function outboundForAction(action) {
  if (action === "indeterminate") return null;
  if (action === "direct") return ROUTE_POLICY_GROUPS.direct.tag;
  if (action === "ai") return ROUTE_POLICY_GROUPS.ai.tag;
  if (action === "block") return "reject";
  return ROUTE_POLICY_GROUPS.proxy.tag;
}

function explained(result, domain, addresses = [], warnings = []) {
  const explanations = {
    custom: "命中管理员自定义规则",
    mode: "由当前全局路由模式决定",
    ai: "命中 RayLink 内置 AI 服务规则",
    local: "命中本机或局域网域名规则",
    "local-ip": "主控解析地址命中私有网络规则",
    "proxy-domain": "命中明确境外服务域名规则",
    geosite: "命中国内域名规则",
    "geosite-cn": "命中完整国内域名规则集",
    "geoip-cn": "解析 IP 命中国内 IP 规则集",
    geoip: "解析 IP 未命中国内 IP 规则集",
    "geoip-mixed": "混合 IP 的路由结果取决于客户端匹配语义与实际选择地址",
    "custom-mixed": "解析地址命中不同的自定义规则，无法推断统一客户端出口",
    "address-limit": "解析地址过多，已停止规则匹配，不能推断完整结果",
    fallback: "规则集暂不可用于诊断，按未知域名回退到代理"
  };
  return {
    domain,
    addresses,
    action: result.action,
    outbound: outboundForAction(result.action),
    source: result.source,
    ruleId: result.ruleId || null,
    dns: result.dns,
    explanation: `${explanations[result.source] || "由统一路由策略决定"}；${addresses.length ? "基于主控系统 DNS 解析推断" : "仅根据规则推断"}，非客户端实测`,
    evidence: {
      kind: addresses.length ? "control-plane-dns" : "rule-inference",
      clientMeasured: false,
      resolver: addresses.length ? "control-plane-system" : null
    },
    warnings: [
      ...(addresses.length ? ["主控 DNS 与客户端 DNS、网络和规则集版本可能不同，不能代表客户端实际出口。"] : []),
      ...warnings
    ],
    checkedAt: new Date().toISOString()
  };
}

export async function diagnoseRoutingDomain({
  domain,
  policy: inputPolicy,
  lookup = nodeLookup,
  matchRuleSet = null,
  lookupTimeoutMs = 2_000
}) {
  const policy = normalizeRoutingPolicy(inputPolicy);
  const initial = routingDecisionForDomain(policy, domain);
  const normalizedDomain = String(domain).trim().toLowerCase().replace(/\.$/, "");
  const isGlobalDefault = (decision) => policy.mode === "global-proxy" && decision.source === "mode";
  if (initial.action !== "resolve" && !isGlobalDefault(initial)) {
    return explained(initial, normalizedDomain);
  }
  let geositeMatch;
  let inferredDns = initial.dns;
  const domainDecision = initial.source === "custom-ip"
    ? routingDecisionForDomain({ ...policy, rules: policy.rules.filter((rule) => (
      !["ip", "ip_cidr"].includes(rule.match)
    )) }, normalizedDomain)
    : initial;
  if (policy.mode === "smart" && domainDecision.source === "geoip") {
    geositeMatch = matchRuleSet
      ? await matchRuleSet("geosite-geolocation-cn.srs", normalizedDomain)
      : null;
    if (geositeMatch === true) {
      inferredDns = "domestic";
      if (initial.source !== "custom-ip") {
        return explained({ action: "direct", source: "geosite-cn", dns: inferredDns }, normalizedDomain);
      }
    }
  }
  let resolved;
  try {
    resolved = await lookupWithDeadline(lookup, normalizedDomain, lookupTimeoutMs);
  } catch (cause) {
    if (["DOMAIN_RESOLUTION_TIMEOUT", "DOMAIN_RESOLUTION_BUSY"].includes(cause.code)) throw cause;
    const error = new Error("域名解析失败，请检查域名或 DNS 状态");
    error.code = "DOMAIN_RESOLUTION_FAILED";
    error.statusCode = 422;
    error.cause = cause;
    throw error;
  }
  const addresses = [...new Map(
    (Array.isArray(resolved) ? resolved : [resolved])
      .filter((entry) => entry?.address)
      .map((entry) => [
        entry.address,
        { address: entry.address, family: Number(entry.family) || null }
      ])
  ).values()];
  if (addresses.length > MAX_DIAGNOSTIC_ADDRESSES) {
    return {
      ...explained({ action: "indeterminate", source: "address-limit", dns: inferredDns },
        normalizedDomain, addresses.slice(0, MAX_DIAGNOSTIC_ADDRESSES),
        [`解析结果超出 ${MAX_DIAGNOSTIC_ADDRESSES} 个地址的诊断上限；仅展示部分地址，未对截断结果推断出口。`]),
      addressCount: addresses.length,
      addressesTruncated: true,
      addressDecisions: [],
      singBoxPrediction: null
    };
  }
  // Evaluate the whole response for sing-box's any-address matching, then each
  // address separately: other client paths may route only their chosen address.
  const geoipMatches = new Map();
  async function classify(candidateAddresses) {
    const decision = routingDecisionForDomain(policy, normalizedDomain, { addresses: candidateAddresses });
    if (decision.action !== "resolve" && !isGlobalDefault(decision)) return { ...decision, dns: inferredDns };
    if (policy.mode === "smart" && geositeMatch === undefined) {
      geositeMatch = matchRuleSet
        ? await matchRuleSet("geosite-geolocation-cn.srs", normalizedDomain)
        : null;
    }
    if (geositeMatch === true) {
      return { action: "direct", source: "geosite-cn", dns: inferredDns };
    }
    if (candidateAddresses.some(({ address }) => PRIVATE_NETWORK_CIDRS.some((value) => (
      routingRuleMatchesIp({ match: "ip_cidr", value }, address)
    )))) {
      return { action: "direct", source: "local-ip", dns: inferredDns };
    }
    if (isGlobalDefault(decision)) return { ...decision, dns: inferredDns };
    if (!matchRuleSet || !candidateAddresses.length) {
      return { action: "proxy", source: "fallback", dns: inferredDns };
    }
    const matches = await Promise.all(candidateAddresses.map(async ({ address }) => {
      if (!geoipMatches.has(address)) {
        geoipMatches.set(address, Promise.resolve().then(() => matchRuleSet("geoip-cn.srs", address)));
      }
      return geoipMatches.get(address);
    }));
    if (matches.some((match) => match === true)) {
      return { action: "direct", source: matches.every((match) => match === true)
        ? "geoip-cn" : "geoip-mixed", dns: inferredDns };
    }
    return { action: "proxy", source: matches.some((match) => match === null || match === undefined)
      ? "fallback" : "geoip", dns: inferredDns };
  }
  const prediction = await classify(addresses);
  const addressDecisions = await Promise.all(addresses.map(async (entry) => ({
    ...entry, ...await classify([entry])
  })));
  const signature = (decision) => `${decision.action}:${decision.ruleId || ""}:${decision.source}`;
  const mixed = addressDecisions.some((decision) => signature(decision) !== signature(prediction));
  const warnings = [];
  const incomplete = prediction.source === "fallback"
    || addressDecisions.some((decision) => decision.source === "fallback")
    || (geositeMatch === null && ["geoip", "geoip-cn", "geoip-mixed", "local-ip"].includes(prediction.source));
  if (incomplete) {
    warnings.push("规则集或解析结果不可用于完整判断；此处仅展示现有证据下的路由建议，客户端仍可能命中其他规则。");
  }
  if (mixed) {
    warnings.push("sing-box 已解析地址按任一地址命中规则；其他客户端或连接路径可能只判断实际选择地址，混合结果不能等同全部直连或全部代理。");
  }
  const result = mixed ? { action: "indeterminate", source: initial.source === "custom-ip"
    ? "custom-mixed" : "geoip-mixed", dns: inferredDns } : prediction;
  return {
    ...explained(result, normalizedDomain, addresses, warnings),
    addressDecisions,
    singBoxPrediction: incomplete ? null : {
      ...prediction, outbound: outboundForAction(prediction.action), matchSemantics: "any-address"
    }
  };
}
