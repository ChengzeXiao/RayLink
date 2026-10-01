import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseRoutingDomain } from "../server/routing/diagnostics.js";

test("routing diagnostics returns a retryable timeout when system DNS does not answer", async () => {
  let release;
  const lookup = () => new Promise((resolve) => { release = resolve; });
  const pending = diagnoseRoutingDomain({ domain: "unknown.example", lookup, lookupTimeoutMs: 10 });
  const result = await Promise.race([
    pending.then(() => ({ code: "UNEXPECTED_SUCCESS" }), (error) => error),
    new Promise((resolve) => setTimeout(() => resolve({ code: "TEST_WAIT_LIMIT" }), 500))
  ]);
  release([]);
  assert.equal(result.code, "DOMAIN_RESOLUTION_TIMEOUT");
  assert.equal(result.statusCode, 504);
  assert.equal(result.retryable, true);
});

test("timed-out diagnostics coalesce identical DNS work until the native lookup settles", async () => {
  let calls = 0, release;
  const lookup = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(diagnoseRoutingDomain({ domain: "pending.example", lookup, lookupTimeoutMs: 10 }), { code: "DOMAIN_RESOLUTION_TIMEOUT" });
  }
  release([]);
  assert.equal(calls, 1, "caller timeout must not start another uncancellable system lookup");
});

test("routing diagnostics bounds simultaneous system DNS work across domains", async () => {
  const releases = [];
  const lookup = () => new Promise((resolve) => releases.push(resolve));
  const results = await Promise.all([0, 1, 2, 3, 4].map((i) => diagnoseRoutingDomain({
    domain: `pending${i}.example`, lookup, lookupTimeoutMs: 10
  }).catch((error) => error)));
  releases.forEach((release) => release([]));
  assert.equal(releases.length, 4);
  assert.equal(results.filter((error) => error.code === "DOMAIN_RESOLUTION_BUSY" && error.statusCode === 503 && error.retryable).length, 1);
});

test("routing diagnostics resolves an unknown domain and explains a China IP decision", async () => {
  const result = await diagnoseRoutingDomain({
    domain: "service.example",
    policy: { mode: "smart", rules: [] },
    lookup: async () => [{ address: "192.0.2.20", family: 4 }],
    matchRuleSet: async (filename, value) => (
      filename === "geoip-cn.srs" && value === "192.0.2.20"
    )
  });

  assert.deepEqual(result.addresses, [{ address: "192.0.2.20", family: 4 }]);
  assert.equal(result.action, "direct");
  assert.equal(result.outbound, "direct");
  assert.equal(result.source, "geoip-cn");
  assert.match(result.explanation, /IP/);
});

test("mixed China and non-China answers expose native any-match without claiming a universal route", async () => {
  const result = await diagnoseRoutingDomain({
    domain: "mixed.example",
    policy: { mode: "smart", rules: [] },
    lookup: async () => [
      { address: "192.0.2.20", family: 4 },
      { address: "203.0.113.30", family: 4 }
    ],
    matchRuleSet: async (filename, value) => (
      filename === "geoip-cn.srs" && value === "192.0.2.20"
    )
  });

  assert.equal(result.action, "indeterminate");
  assert.equal(result.outbound, null);
  assert.equal(result.source, "geoip-mixed");
  assert.equal(result.singBoxPrediction.action, "direct");
  assert.equal(result.singBoxPrediction.matchSemantics, "any-address");
  assert.deepEqual(result.addressDecisions.map((entry) => entry.action), ["direct", "proxy"]);
  assert.equal(result.dns, "remote");
  assert.match(result.warnings.join(" "), /任一.*地址|地址.*任一/);
});

test("routing diagnostics honors an explicit rule without DNS lookup", async () => {
  let lookups = 0;
  const result = await diagnoseRoutingDomain({
    domain: "app.work.example",
    policy: {
      mode: "smart",
      rules: [{
        match: "domain_suffix",
        value: "work.example",
        action: "direct"
      }]
    },
    lookup: async () => {
      lookups += 1;
      return [];
    }
  });

  assert.equal(result.source, "custom");
  assert.equal(result.action, "direct");
  assert.equal(lookups, 0);
  assert.equal(result.evidence.kind, "rule-inference");
  assert.equal(result.evidence.clientMeasured, false);
  assert.match(result.explanation, /非客户端实测/);
});

test("routing diagnostics reports a conservative fallback when rule-set matching is unavailable", async () => {
  const result = await diagnoseRoutingDomain({
    domain: "unknown.example",
    policy: { mode: "smart", rules: [] },
    lookup: async () => [{ address: "192.0.2.20", family: 4 }],
    matchRuleSet: async () => null
  });

  assert.equal(result.action, "proxy");
  assert.equal(result.source, "fallback");
  assert.equal(result.singBoxPrediction, null);
  assert.match(result.warnings.join(" "), /规则集/);
});

test("diagnostics evaluates IP rules before lower-priority domain rules, including in direct mode", async () => {
  const policy = { mode: "direct", rules: [
    { id: "block-network", match: "ip_cidr", value: "203.0.113.0/24", action: "block", priority: 1 },
    { id: "allow-domain", match: "domain", value: "service.example", action: "direct", priority: 2 }
  ] };
  const blocked = await diagnoseRoutingDomain({ domain: "service.example", policy,
    lookup: async () => [{ address: "203.0.113.8", family: 4 }] });
  assert.equal(blocked.action, "block");
  assert.equal(blocked.ruleId, "block-network");
  assert.equal(blocked.evidence.kind, "control-plane-dns");
  const allowed = await diagnoseRoutingDomain({ domain: "service.example", policy,
    lookup: async () => [{ address: "192.0.2.8", family: 4 }] });
  assert.equal(allowed.ruleId, "allow-domain");
});

test("mixed addresses hitting different custom rules are not reported as one certain outcome", async () => {
  const result = await diagnoseRoutingDomain({ domain: "service.example",
    policy: { rules: [
      { id: "block-ipv6", match: "ip_cidr", value: "2001:db8:1::/48", action: "block", priority: 1 },
      { id: "allow-domain", match: "domain", value: "service.example", action: "direct", priority: 2 }
    ] },
    lookup: async () => [{ address: "192.0.2.8", family: 4 }, { address: "2001:db8:1::8", family: 6 }]
  });
  assert.equal(result.action, "indeterminate");
  assert.equal(result.singBoxPrediction.action, "block");
  assert.deepEqual(result.addressDecisions.map((entry) => entry.ruleId), ["allow-domain", "block-ipv6"]);
});

test("unknown split-DNS names retain late private-IP bypass without requiring a GeoIP ruleset", async () => {
  for (const mode of ["smart", "global-proxy"]) {
    const result = await diagnoseRoutingDomain({ domain: "internal.company.example", policy: { mode },
      lookup: async () => [{ address: "10.30.0.8", family: 4 }] });
    assert.equal(result.action, "direct");
    assert.equal(result.source, "local-ip");
    assert.equal(result.evidence.kind, "control-plane-dns");
  }
});

test("DNS classification still uses the full domestic domain set before evaluating custom IP routes", async () => {
  const result = await diagnoseRoutingDomain({ domain: "www.csdn.net",
    policy: { rules: [{ match: "ip_cidr", value: "203.0.113.0/24", action: "block" }] },
    lookup: async () => [{ address: "192.0.2.8", family: 4 }],
    matchRuleSet: async (filename) => filename === "geosite-geolocation-cn.srs"
  });
  assert.equal(result.source, "geosite-cn");
  assert.equal(result.dns, "domestic");
});

test("large DNS answer sets stop diagnosis explicitly rather than spawning unbounded matchers", async () => {
  let ipChecks = 0;
  const result = await diagnoseRoutingDomain({ domain: "large.example", policy: {},
    lookup: async () => Array.from({ length: 100 }, (_, index) => ({ address: `192.0.2.${index + 1}`, family: 4 })),
    matchRuleSet: async (filename) => { if (filename === "geoip-cn.srs") ipChecks++; return false; }
  });
  assert.equal(result.action, "indeterminate");
  assert.equal(result.outbound, null);
  assert.equal(result.singBoxPrediction, null);
  assert.equal(result.addresses.length, 16);
  assert.equal(result.addressCount, 100);
  assert.equal(result.addressesTruncated, true);
  assert.match(result.warnings.join(" "), /超出.*16|16.*上限/);
  assert.equal(ipChecks, 0);
});
