import { domainToASCII } from "node:url";
import { isIP } from "node:net";
import { AI_DOMAIN_NAMES, AI_DOMAIN_SUFFIXES, normalizeRoutingPolicy } from "./policy.js";

export const AI_DOMAIN_RULES_VERSION = "2026-10-04.1";

// Client routing also covers shared login/challenge dependencies. Residential
// egress is narrower: those shared providers serve ordinary websites as well,
// and an encrypted connection cannot reveal which website initiated it.
const sharedDomains = new Set([
  "challenges.cloudflare.com", "cdn.workos.com", "forwarder.workos.com",
  "setup.workos.com", "images.workoscdn.com", "workos.imgix.net"
]);
export const AI_UPSTREAM_DOMAIN_NAMES = Object.freeze(AI_DOMAIN_NAMES.filter(domain => !sharedDomains.has(domain)));
export const AI_UPSTREAM_DOMAIN_SUFFIXES = Object.freeze(AI_DOMAIN_SUFFIXES.filter(domain => !sharedDomains.has(domain)));
const protectedDomains = Object.freeze([
  "google.com", "google.co.uk", "google.co.jp", "google.com.hk", "google.com.tw", "google.com.sg", "google.com.au", "google.de", "google.fr", "google.ca",
  "googleapis.com", "gstatic.com", "googleusercontent.com", "gmail.com", "youtube.com", "youtu.be", "googlevideo.com", "ytimg.com",
  "x.com", "twitter.com", "t.co", "twimg.com", "instagram.com", "cdninstagram.com", "facebook.com", "fbcdn.net",
  "microsoft.com", "microsoftonline.com", "microsoftonline-p.com", "microsoftonline-p.net", "live.com", "windows.net", "cloud.microsoft",
  "github.com", "githubusercontent.com", "githubassets.com",
  "cloudflare.com", "cloudflare.net", "cloudfront.net", "amazonaws.com", "azureedge.net", "akamaized.net", "akamaihd.net", "fastly.net", "jsdelivr.net", "unpkg.com",
  "workos.com", "workoscdn.com", "imgix.net", "localhost", "local", "lan", "home.arpa"
]);

function builtinMatch() {
  return { domain: [...AI_UPSTREAM_DOMAIN_NAMES], domain_suffix: [...AI_UPSTREAM_DOMAIN_SUFFIXES] };
}

function sharedCustomAiMatch(rule) {
  return { type: "logical", mode: "and", rules: [
    { [rule.match]: [rule.value] }, { domain_suffix: [...protectedDomains] },
    { ...builtinMatch(), invert: true }
  ] };
}

export function compileAiUpstreamRules(policy = {}, { resolveRule } = {}) {
  const rules = normalizeRoutingPolicy(policy).rules.filter(rule => rule.enabled && ["domain", "domain_suffix"].includes(rule.match));
  const compiled = [
    ...rules.flatMap(rule => rule.action === "ai" && !isIP(rule.value) ? [
      // A protected first match must terminate, not fall through into a later
      // rule whose action differs from the client's first matching AI rule.
      { ...sharedCustomAiMatch(rule), action: "route", outbound: "direct" },
      { [rule.match]: [rule.value], network: "udp", action: "reject" },
      { [rule.match]: [rule.value], network: "tcp", action: "route", outbound: "ai-residential" }
    ] : [{ [rule.match]: [rule.value], action: rule.action === "block" ? "reject" : "route", ...(rule.action === "block" ? {} : { outbound: "direct" }) }]),
    { domain: [...AI_UPSTREAM_DOMAIN_NAMES], domain_suffix: [...AI_UPSTREAM_DOMAIN_SUFFIXES], network: "udp", action: "reject" },
    { domain: [...AI_UPSTREAM_DOMAIN_NAMES], domain_suffix: [...AI_UPSTREAM_DOMAIN_SUFFIXES], network: "tcp", action: "route", outbound: "ai-residential" }
  ];
  // Ordinary exceptions and shared-provider guards terminate before the
  // general Runtime resolver. Preserve its DNS rules/fallback on those paths;
  // residential targets must stay unresolved for remote DNS, and rejects need
  // no lookup. System-DNS mode deliberately supplies no explicit resolve rule.
  return compiled.flatMap(rule => {
    if (!resolveRule || rule.action !== "route" || rule.outbound !== "direct") return [rule];
    const { action: _action, outbound: _outbound, ...match } = rule;
    return [{ ...match, ...resolveRule }, rule];
  });
}

function normalizedDomain(value) {
  if (typeof value !== "string") return null;
  const domain = domainToASCII(value.trim().replace(/\.$/, "").toLowerCase());
  if (!domain || isIP(domain) || domain.length > 253 || domain.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return domain;
}

const matchesSuffix = (domain, suffix) => domain === suffix || domain.endsWith(`.${suffix}`);

export function describeAiDomain(value, policy = {}) {
  const domain = normalizedDomain(value);
  const result = { eligible: false, source: "none", match: null, value: null, ruleId: null,
    reason: "未命中 AI 专用域名；IP/CIDR 规则仅控制客户端入口，不扩大住宅域名范围。" };
  if (!domain) return { ...result, reason: "需要有效域名；IP、URL 或无法识别的目标不会据此认定为 AI 专用流量。" };
  const rules = normalizeRoutingPolicy(policy).rules;
  const exact = AI_UPSTREAM_DOMAIN_NAMES.find(name => domain === name);
  const suffix = AI_UPSTREAM_DOMAIN_SUFFIXES.find(name => matchesSuffix(domain, name));
  const builtin = exact || suffix;
  const shared = protectedDomains.find(name => matchesSuffix(domain, name));
  const custom = rules.find(rule => rule.enabled && (rule.match === "domain" ? domain === rule.value
    : rule.match === "domain_suffix" && matchesSuffix(domain, rule.value)));
  if (custom) {
    const evidence = { ...result, source: "custom", match: custom.match, value: custom.value, ruleId: custom.id };
    if (custom.action !== "ai") return { ...evidence,
      reason: `优先命中自定义 ${custom.action} 规则，不进入住宅代理；客户端仍按该规则处理。` };
    if (shared && !builtin) return { ...evidence, source: "shared",
      reason: "命中共享服务或普通网站保护范围；自定义 AI 规则不会将其送入住宅代理。" };
    return { ...evidence, eligible: true, reason: "命中自定义 AI 专用域名；住宅启用并成功发布后，识别到该域名的 TCP 流量可使用住宅代理。" };
  }
  if (builtin) return { ...result, eligible: true, source: "builtin", match: exact ? "domain" : "domain_suffix", value: builtin,
    reason: "命中内置 AI 专用域名；住宅启用并成功发布后，识别到该域名的 TCP 流量可使用住宅代理。" };
  if (shared) return { ...result, source: "shared", match: "domain_suffix", value: shared,
    reason: "共享服务或普通网站保留默认出口，不进入住宅代理。" };
  return result;
}

export function isAiUpstreamDomain(value, policy = {}) {
  return describeAiDomain(value, policy).eligible;
}

export function aiDomainRulesView(policy = {}) {
  return { version: AI_DOMAIN_RULES_VERSION, domainNames: [...AI_DOMAIN_NAMES], domainSuffixes: [...AI_DOMAIN_SUFFIXES],
    sharedDomains: [...sharedDomains], protectedDomains: [...protectedDomains],
    customRules: normalizeRoutingPolicy(policy).rules.filter(rule => ["domain", "domain_suffix"].includes(rule.match)) };
}
