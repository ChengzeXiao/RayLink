import assert from "node:assert/strict";
import test from "node:test";
import { buildSingBoxConfig } from "../server/singbox/config.js";
import * as aiDomains from "../server/routing/ai-upstream-domains.js";

const upstream = { enabled: true, hostId: "local", type: "socks5", server: "127.0.0.1", port: 1080 };
const snapshot = (rules = [], aiUpstream = upstream) => ({
  host: { id: "local", kind: "local", runtimeVersion: "1.14.2", region: "us" },
  protocols: [], users: [], masterPassword: "fixture", aiUpstream,
  routingPolicy: { mode: "smart", rules }
});
// Interpret the public sing-box domain/network rule format, independently of
// RayLink's classification code. Unknown nonterminal actions do not select egress.
function matches(rule, domain, network) {
  let result;
  if (rule.type === "logical") {
    result = rule.mode === "and"
      ? rule.rules.every(item => matches(item, domain, network))
      : rule.rules.some(item => matches(item, domain, network));
  } else {
    const domains = !rule.domain && !rule.domain_suffix || rule.domain?.includes(domain)
      || rule.domain_suffix?.some(suffix => domain === suffix || domain.endsWith(`.${suffix}`));
    result = Boolean(domains) && (!rule.network || rule.network === network);
  }
  return rule.invert ? !result : result;
}
function destination(config, domain, network = "tcp") {
  const rule = (config.route.rules || []).find(item => ["route", "reject"].includes(item.action) && matches(item, domain, network));
  return rule?.action === "reject" ? "reject" : rule?.outbound || config.route.final;
}

test("an explicitly added AI domain reaches residential egress while adjacent ordinary domains retain the default", () => {
  const config = buildSingBoxConfig(snapshot([{ id: "new-ai", match: "domain", value: "assistant.example", action: "ai" }]));
  assert.equal(destination(config, "assistant.example"), "ai-residential");
  assert.equal(destination(config, "assistant.example", "udp"), "reject");
  assert.equal(destination(config, "www.assistant.example"), "direct");
  assert.equal(destination(config, "assistant.example.evil.invalid"), "direct");
});

test("broad custom AI rules cannot move shared provider sites into residential but retain dedicated built-in AI exceptions", () => {
  const config = buildSingBoxConfig(snapshot([
    ...["google.com", "googleapis.com", "gstatic.com", "youtube.com", "x.com", "instagram.com", "githubusercontent.com", "microsoft.com", "microsoftonline.com", "cloudflare.com", "workos.com", "co.uk"].map((value, index) =>
      ({ id: `broad-${index}`, match: "domain_suffix", value, action: "ai" })),
    { id: "shared-exact", match: "domain", value: "workos.imgix.net", action: "ai" }
  ]));
  for (const domain of ["www.google.com", "accounts.google.com", "maps.googleapis.com", "fonts.gstatic.com", "www.youtube.com", "x.com", "instagram.com", "raw.githubusercontent.com", "login.microsoftonline.com", "www.microsoft.com", "challenges.cloudflare.com", "cdn.workos.com", "workos.imgix.net", "www.google.co.uk"]) {
    assert.equal(destination(config, domain), "direct", domain);
    assert.equal(destination(config, domain, "udp"), "direct", domain);
  }
  for (const domain of ["gemini.google.com", "aistudio.google.com", "generativelanguage.googleapis.com", "copilot.microsoft.com", "copilot-proxy.githubusercontent.com"]) {
    assert.equal(destination(config, domain), "ai-residential", domain);
  }
  assert.equal(destination(config, "api.aistudio.google.com"), "direct", "an exact built-in carve-out must not promote its subdomains");
  assert.equal(destination(config, "api.new-assistant.co.uk"), "ai-residential", "unrelated dedicated domain rules remain usable");
});

test("domain explanations expose the effective custom rule and shared guard without claiming IP-only routing", () => {
  const policy = snapshot([
    { id: "shared", match: "domain_suffix", value: "google.com", action: "ai", priority: 30 },
    { id: "assistant", match: "domain", value: "assistant.example", action: "ai", priority: 20 },
    { id: "ordinary", match: "domain", value: "claude.ai", action: "proxy", priority: 10 },
    { id: "ip-ai", match: "ip", value: "192.0.2.1", action: "ai", priority: 0 }
  ]).routingPolicy;
  const custom = aiDomains.describeAiDomain("Assistant.Example.", policy);
  assert.deepEqual({ eligible: custom.eligible, source: custom.source, ruleId: custom.ruleId, match: custom.match, value: custom.value },
    { eligible: true, source: "custom", ruleId: "assistant", match: "domain", value: "assistant.example" });
  const excluded = aiDomains.describeAiDomain("claude.ai", policy);
  assert.equal(excluded.eligible, false);
  assert.equal(excluded.ruleId, "ordinary");
  const shared = aiDomains.describeAiDomain("accounts.google.com", policy);
  assert.equal(shared.eligible, false);
  assert.equal(shared.source, "shared");
  assert.equal(shared.ruleId, "shared");
  assert.ok(shared.reason);
  assert.equal(aiDomains.describeAiDomain("gemini.google.com", policy).eligible, true);
  assert.equal(aiDomains.describeAiDomain("api.openai.com", policy).source, "builtin");
  for (const domain of ["192.0.2.1", "unknown.example", "https://claude.ai", "a..claude.ai"]) {
    const explanation = aiDomains.describeAiDomain(domain, policy);
    assert.equal(explanation.eligible, false, domain);
    assert.ok(explanation.reason, domain);
  }
});

test("the readable catalog preserves disabled and non-AI exceptions without exposing unrelated policy fields", () => {
  const policy = { ...snapshot([
    { id: "exclude", match: "domain", value: "claude.ai", action: "proxy", priority: 20 },
    { id: "disabled", match: "domain_suffix", value: "assistant.example", action: "ai", enabled: false, priority: 10 },
    { id: "ip", match: "ip", value: "192.0.2.1", action: "ai" }
  ]).routingPolicy, password: "unrelated-sensitive-field" };
  const view = aiDomains.aiDomainRulesView(policy);
  assert.equal(view.version, "2026-10-04.1");
  assert.ok(view.domainSuffixes.includes("claude.ai"));
  assert.ok(view.domainNames.includes("aistudio.google.com"));
  assert.ok(view.sharedDomains.includes("cdn.workos.com"));
  assert.ok(view.protectedDomains.includes("google.com"));
  assert.deepEqual(view.customRules.map(rule => [rule.id, rule.action, rule.enabled]), [["disabled", "ai", false], ["exclude", "proxy", true]]);
  assert.doesNotMatch(JSON.stringify(view), /unrelated-sensitive-field/);
});

test("first matching domain rules retain priority for additions, exclusions, blocked sites and protected providers", () => {
  const config = buildSingBoxConfig(snapshot([
    { id: "late-block", match: "domain", value: "www.google.com", action: "block", priority: 80 },
    { id: "broad-ai", match: "domain_suffix", value: "google.com", action: "ai", priority: 60 },
    { id: "exclude", match: "domain", value: "aistudio.google.com", action: "proxy", priority: 10 },
    { id: "blocked", match: "domain", value: "blocked.assistant.example", action: "block", priority: 10 },
    { id: "disabled", match: "domain", value: "chatgpt.com", action: "proxy", enabled: false, priority: 0 },
    { id: "new-ai", match: "domain_suffix", value: "assistant.example", action: "ai", priority: 20 }
  ]));
  assert.equal(destination(config, "www.google.com"), "direct", "a guarded earlier AI rule retains the ordinary path before later rules");
  assert.equal(destination(config, "aistudio.google.com"), "direct", "earlier exact exclusion wins over a later broad AI rule");
  assert.equal(destination(config, "blocked.assistant.example"), "reject");
  assert.equal(destination(config, "api.assistant.example"), "ai-residential");
  assert.equal(destination(config, "chatgpt.com"), "ai-residential", "disabled exclusions do not change built-in coverage");
});

test("IP rules and disabled domain rules do not expand residential coverage; disabled upstream leaves all Runtime output unchanged", () => {
  const baseline = buildSingBoxConfig(snapshot());
  const ineffective = [
    { id: "ip", match: "ip", value: "192.0.2.1", action: "ai" },
    { id: "network", match: "ip_cidr", value: "198.51.100.0/24", action: "ai" },
    { id: "disabled", match: "domain_suffix", value: "assistant.example", action: "ai", enabled: false }
  ];
  assert.deepEqual(buildSingBoxConfig(snapshot(ineffective)), baseline);
  const rules = [{ id: "new-ai", match: "domain_suffix", value: "assistant.example", action: "ai" },
    { id: "exclude", match: "domain", value: "claude.ai", action: "proxy" }];
  assert.deepEqual(buildSingBoxConfig(snapshot(rules, { ...upstream, enabled: false })), buildSingBoxConfig(snapshot([], null)));
  assert.equal(destination(buildSingBoxConfig(snapshot(ineffective)), "192.0.2.1"), "direct");
});

test("local infrastructure and IP literals cannot be classified as residential even by a custom AI domain rule", () => {
  const config = buildSingBoxConfig(snapshot([
    { id: "loopback", match: "domain", value: "127.0.0.1", action: "ai" },
    { id: "local", match: "domain", value: "localhost", action: "ai" },
    { id: "lan", match: "domain_suffix", value: "office.local", action: "ai" }
  ]));
  for (const domain of ["127.0.0.1", "localhost", "printer.office.local"]) {
    assert.equal(destination(config, domain), "direct", domain);
  }
});
