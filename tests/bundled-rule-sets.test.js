import assert from "node:assert/strict";
import test from "node:test";
import { getBundledRoutingRules } from "../server/routing/rule-sets/bundled.js";

test("inline bundled policy contains the complete domain and IP classification fields", () => {
  const { geosite, geoip } = getBundledRoutingRules();
  assert.ok(geosite.some((rule) => rule.domain_suffix.includes("baidu.com")));
  assert.ok(geosite.reduce((count, rule) => count + (rule.domain?.length || 0), 0) > 600);
  assert.equal(geosite.reduce((count, rule) => count + (rule.domain_regex?.length || 0), 0), 8);
  assert.ok(geoip.reduce((count, rule) => count + (rule.ip_cidr?.length || 0), 0) > 7000);
  assert.ok(geoip.some((rule) => rule.ip_cidr.some((cidr) => cidr.includes(":"))));
});
