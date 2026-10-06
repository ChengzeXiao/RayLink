import assert from "node:assert/strict";
import test from "node:test";
import { buildProtocolClientConfig, defaultProtocolConfigs } from "../server/singbox/protocol-catalog.js";
import { buildSubscriptionArtifact } from "../server/subscriptions/formats.js";

function client(routePolicy = {}) {
  return buildProtocolClientConfig({ profiles: defaultProtocolConfigs(), server: "node.example.com",
    credential: { email: "fixture@example.com", runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d", runtimePassword: "AAAAAAAAAAAAAAAAAAAAAA==", serverPassword: "AAAAAAAAAAAAAAAAAAAAAA==" },
    routePolicy });
}
function exportProfile(format, routePolicy = {}) {
  return buildSubscriptionArtifact({ format, routePolicy, singBoxConfig: client(routePolicy) }).body;
}
function domainRule(rules, domain, targetField) {
  return rules.find(rule => rule[targetField] && (rule.domain?.includes(domain)
    || rule.domain_suffix?.some(suffix => domain === suffix || domain.endsWith(`.${suffix}`))));
}

test("sing-box smart DNS and routing keep new Chinese app domains domestic before the complete CN rule set", () => {
  const config = client();
  for (const domain of ["qianshouapp.cn", "h5.qianshouapp.cn", "fresh-domestic-app.cn"]) {
    assert.equal(domainRule(config.dns.rules, domain, "server")?.server, "dns-domestic", domain);
    assert.equal(domainRule(config.route.rules, domain, "outbound")?.outbound, "direct", domain);
  }
  assert.ok(config.route.rules.findIndex(rule => rule.outbound === "direct" && rule.domain_suffix?.includes("cn"))
    < config.route.rules.findIndex(rule => rule.rule_set === "geosite-geolocation-cn"));
  assert.equal(domainRule(config.dns.rules, "fresh-overseas-app.example", "server"), undefined);
  assert.equal(config.dns.final, "dns-remote");
});

test("both full Mihomo exports preserve the same domestic fallback in DNS and route order", () => {
  for (const format of ["mihomo", "mihomo-modern"]) {
    const body = exportProfile(format);
    const dns = body.split("  nameserver-policy:\n")[1].split("  proxy-server-nameserver:")[0];
    assert.match(dns, /"\+\.cn":\n\s+- "https:\/\/223\.5\.5\.5\/dns-query"/, format);
    const routes = body.split("\nrules:\n")[1];
    assert.ok(routes.indexOf("DOMAIN-SUFFIX,cn,DIRECT") > routes.indexOf("DOMAIN-SUFFIX,google.com,RayLink 代理"), format);
    assert.ok(routes.indexOf("DOMAIN-SUFFIX,cn,DIRECT") < routes.indexOf("RULE-SET,raylink-cn-domain,DIRECT"), format);
    assert.ok(routes.endsWith('"MATCH,未分类流量"\n'), "unclassified traffic uses its selector after domestic classification");
  }
});

test("the full Egern profile pairs domestic fallback DNS with direct routing after explicit overseas domains", () => {
  const body = exportProfile("egern-profile");
  const dns = body.split("  forward:\n")[1].split("  proxy_nameservers:")[0];
  const routes = body.split("\nrules:\n")[1];
  const dnsRule = 'domain_suffix:\n        match: "cn"\n        value: "domestic"';
  const routeRule = 'domain_suffix:\n      match: "cn"\n      policy: "DIRECT"';
  assert.ok(dns.includes(dnsRule));
  assert.ok(routes.includes(routeRule));
  assert.ok(dns.indexOf(dnsRule) > dns.indexOf('match: "google.com"\n        value: "overseas"'));
  assert.ok(routes.indexOf(routeRule) > routes.indexOf('match: "google.com"\n      policy: "RayLink 代理"'));
  assert.ok(routes.indexOf(routeRule) < routes.indexOf('domain_regex:'));
});

test("Chinese fallback keeps custom AI, proxy and DNS overrides ahead of domestic routing in every full export", () => {
  const policy = { mode: "smart", rules: [
    { id: "ai-cn", match: "domain", value: "assistant.example.cn", action: "ai", priority: 10 },
    { id: "proxy-cn", match: "domain_suffix", value: "qianshouapp.cn", action: "proxy", priority: 20 },
    { id: "system-cn", match: "domain", value: "office.example.cn", action: "direct", dns: "system", priority: 30 }
  ] };
  const config = client(policy);
  for (const [domain, dns, outbound] of [["assistant.example.cn", "dns-ai", "raylink-ai"], ["h5.qianshouapp.cn", "dns-remote", "raylink-auto"], ["office.example.cn", "dns-local", "direct"], ["claude.ai", "dns-ai", "raylink-ai"], ["www.google.com", "dns-remote", "raylink-auto"]]) {
    assert.equal(domainRule(config.dns.rules, domain, "server")?.server, dns, domain);
    assert.equal(domainRule(config.route.rules, domain, "outbound")?.outbound, outbound, domain);
  }
  for (const format of ["mihomo", "mihomo-modern"]) {
    const body = exportProfile(format, policy);
    const dns = body.split("  nameserver-policy:\n")[1].split("  proxy-server-nameserver:")[0];
    const routes = body.split("\nrules:\n")[1];
    assert.match(dns, /"assistant\.example\.cn":\n\s+- "https:\/\/1\.1\.1\.1\/dns-query#AI 网站代理"/);
    assert.match(dns, /"\+\.qianshouapp\.cn":\n\s+- "https:\/\/1\.1\.1\.1\/dns-query#RayLink 代理"/);
    assert.match(dns, /"office\.example\.cn":\n\s+- "system"/);
    assert.ok(routes.indexOf("DOMAIN,assistant.example.cn,AI 网站代理") < routes.indexOf("DOMAIN-SUFFIX,cn,DIRECT"));
    assert.ok(routes.indexOf("DOMAIN-SUFFIX,qianshouapp.cn,RayLink 代理") < routes.indexOf("DOMAIN-SUFFIX,cn,DIRECT"));
  }
  const egern = exportProfile("egern-profile", policy);
  const dns = egern.split("  forward:\n")[1].split("  proxy_nameservers:")[0];
  const routes = egern.split("\nrules:\n")[1];
  assert.ok(dns.indexOf('match: "assistant.example.cn"\n        value: "ai"') < dns.indexOf('match: "cn"\n        value: "domestic"'));
  assert.ok(routes.indexOf('match: "qianshouapp.cn"\n      policy: "RayLink 代理"') < routes.indexOf('match: "cn"\n      policy: "DIRECT"'));
});

test("fallback only applies in smart mode and does not force re-resolution after custom IP precedence", () => {
  for (const mode of ["direct", "global-proxy"]) {
    const config = client({ mode });
    assert.equal(config.dns.rules.some(rule => rule.domain_suffix?.includes("cn")), false);
    assert.equal(config.route.rules.some(rule => rule.domain_suffix?.includes("cn")), false);
    for (const format of ["mihomo", "mihomo-modern", "egern-profile"]) {
      const body = exportProfile(format, { mode });
      assert.doesNotMatch(body, /"\+\.cn":|DOMAIN-SUFFIX,cn,DIRECT|match: "cn"/);
    }
  }
  const config = client({ rules: [{ match: "ip_cidr", value: "192.0.2.0/24", action: "proxy" }] });
  const customIp = config.route.rules.findIndex(rule => rule.ip_cidr?.includes("192.0.2.0/24"));
  assert.ok(customIp >= 0);
  assert.equal(config.route.rules.slice(customIp + 1).some(rule => rule.action === "resolve"), false);
  assert.equal(domainRule(config.route.rules, "qianshouapp.cn", "outbound")?.outbound, "direct");
});
