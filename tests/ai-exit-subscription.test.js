import assert from "node:assert/strict";
import test from "node:test";
import { buildMultiHostProtocolClientConfig, buildProtocolClientConfig, defaultProtocolConfigs } from "../server/singbox/protocol-catalog.js";
import { buildSubscriptionArtifact } from "../server/subscriptions/formats.js";

const credential = {
  runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d",
  runtimePassword: "dXNlci1wYXNzd29yZA==",
  serverPassword: "AAAAAAAAAAAAAAAAAAAAAA=="
};
const protocols = defaultProtocolConfigs().filter((profile) => ["vless", "hysteria2"].includes(profile.type))
  .map((profile) => ({ ...profile, enabled: true }));
const hosts = [
  { id: "vps-a", name: "Tokyo", address: "a.example.com", protocols },
  { id: "vps-a-extra", name: "Tokyo", address: "b.example.com", protocols }
];
const pinnedPolicy = { aiExit: { mode: "pinned", hostId: "vps-a" } };
const members = (config, tag) => config.outbounds.find((outbound) => outbound.tag === tag)?.outbounds;

test("pinning AI to a Host restricts all AI choices while ordinary traffic retains every Host", () => {
  const config = buildMultiHostProtocolClientConfig({ credential, hosts, routePolicy: pinnedPolicy });
  assert.deepEqual(members(config, "raylink-ai-stable"), ["raylink-vps-a-vless", "raylink-vps-a-hysteria2"]);
  assert.deepEqual(members(config, "raylink-ai"), ["raylink-ai-stable", "raylink-vps-a-vless", "raylink-vps-a-hysteria2"]);
  assert.ok(members(config, "raylink-auto").includes("raylink-vps-a-extra-vless"));
  assert.equal(config.outbounds.filter((outbound) => outbound.server).length, 4);
  const renamed = buildMultiHostProtocolClientConfig({ credential, hosts: hosts.map((host) => ({ ...host, name: "Renamed" })), routePolicy: pinnedPolicy });
  assert.deepEqual(members(renamed, "raylink-ai-stable"), members(config, "raylink-ai-stable"));
});

test("missing or ineligible AI Host rejects AI only without native placeholder outbounds", () => {
  const routePolicy = { ...pinnedPolicy, rules: [
    { match: "domain", value: "custom-ai.example", action: "ai" },
    { match: "ip", value: "198.51.100.24", action: "ai" },
    { match: "domain", value: "ordinary.example", action: "proxy" }
  ] };
  const inputs = [hosts.slice(1), hosts.map((host) => host.id === "vps-a" ? { ...host, protocols: [] } : host)];
  const configs = inputs.map((available) => buildMultiHostProtocolClientConfig({ credential, hosts: available, routePolicy }));
  configs.push(buildProtocolClientConfig({ credential, profiles: protocols, server: "unmapped.example", routePolicy }));
  for (const config of configs) {
    assert.equal(members(config, "raylink-ai"), undefined);
    assert.equal(members(config, "raylink-ai-stable"), undefined);
    assert.equal(config.dns.servers.some((server) => server.tag === "dns-ai"), false);
    const aiRoute = config.route.rules.find((rule) => rule.domain_suffix?.includes("claude.ai") && rule.action !== "resolve");
    assert.equal(aiRoute.action, "reject");
    for (const field of ["route", "dns"]) {
      assert.equal(config[field].rules.find((rule) => rule.domain?.includes("custom-ai.example") && rule.action !== "resolve").action, "reject");
    }
    assert.equal(config.route.rules.find((rule) => rule.ip_cidr?.includes("198.51.100.24/32")).action, "reject");
    assert.equal(config.dns.rules.find((rule) => rule.domain_suffix?.includes("claude.ai")).action, "reject");
    assert.equal(config.route.rules.find((rule) => rule.domain?.includes("ordinary.example") && rule.action === "route").outbound, "raylink-auto");
    assert.ok(members(config, "raylink-auto").length > 0);
    assert.equal(config.outbounds.some((outbound) => outbound.type === "block"), false);
    assert.equal(JSON.stringify(config).includes('"raylink-ai"'), false);
  }
});

test("every full client export keeps pinned AI choices inside the Host and blocks an unavailable pin", () => {
  const section = (body, name) => body.split(`name: "${name}"`)[1]?.split(/\n  - /)[0];
  for (const format of ["mihomo", "mihomo-modern", "egern-profile"]) {
    for (const available of [hosts, hosts.slice(1)]) {
      const singBoxConfig = buildMultiHostProtocolClientConfig({ credential, hosts: available, routePolicy: pinnedPolicy });
      const { body } = buildSubscriptionArtifact({ format, singBoxConfig, routePolicy: pinnedPolicy });
      const ai = section(body, "AI 网站代理");
      const stable = section(body, "AI 稳定出口");
      assert.ok(ai && stable, format);
      for (const group of [ai, stable, section(body, "AI 节点选择")].filter(Boolean)) {
        assert.doesNotMatch(group, /raylink-vps-a-extra|RayLink 智能|手动选择|故障回退|TCP 稳定|UDP 高速|网络环境|DIRECT/, format);
      }
      if (available.length === 2) {
        assert.match(stable, /raylink-vps-a-vless/, format);
        assert.match(stable, /raylink-vps-a-hysteria2/, format);
      } else {
        assert.match(stable, /REJECT/, format);
        assert.doesNotMatch(ai, /raylink-vps-a/, format);
      }
      assert.match(body, /raylink-vps-a-extra-vless/, "ordinary subscription retains the other Host");
    }
  }
});
