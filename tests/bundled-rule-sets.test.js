import assert from "node:assert/strict";
import test from "node:test";
import { BlockList, isIP } from "node:net";
import { getBundledRoutingRules } from "../server/routing/rule-sets/bundled.js";

test("inline bundled policy contains the complete domain and IP classification fields", () => {
  const { geosite, geoip } = getBundledRoutingRules();
  assert.ok(geosite.some((rule) => rule.domain_suffix.includes("baidu.com")));
  assert.ok(geosite.reduce((count, rule) => count + (rule.domain?.length || 0), 0) > 600);
  assert.equal(geosite.reduce((count, rule) => count + (rule.domain_regex?.length || 0), 0), 8);
  assert.ok(geoip.reduce((count, rule) => count + (rule.ip_cidr?.length || 0), 0) > 7000);
  assert.ok(geoip.some((rule) => rule.ip_cidr.some((cidr) => cidr.includes(":"))));
});

test("domestic IP fallback recognizes geographically Chinese cloud IPs without including their overseas neighbors", () => {
  const domestic = new BlockList();
  for (const rule of getBundledRoutingRules().geoip) {
    for (const cidr of rule.ip_cidr || []) {
      const [address, prefix] = cidr.split("/");
      domestic.addSubnet(address, Number(prefix), isIP(address) === 6 ? "ipv6" : "ipv4");
    }
  }
  // Independent country samples: DB-IP Country Lite 2026-10 and GeoLite2
  // Country 2026-09-12 both identify the first cloud address as CN, although
  // GeoLite2 registered_country is SG. Do not widen to an entire cloud ASN.
  for (const ip of ["8.141.181.226", "114.114.114.114", "223.5.5.5", "2400:3200::1"]) {
    assert.equal(domestic.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4"), true, `${ip} must use domestic fallback`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "47.88.0.1", "104.18.32.7", "160.79.104.10", "2606:4700:4700::1111"]) {
    assert.equal(domestic.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4"), false, `${ip} must remain outside domestic fallback`);
  }
});
