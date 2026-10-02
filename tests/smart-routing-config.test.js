import assert from "node:assert/strict";
import test from "node:test";
import { buildMultiHostProtocolClientConfig, buildProtocolClientConfig, defaultProtocolConfigs } from "../server/singbox/protocol-catalog.js";

function clientConfig(routePolicy) {
  return buildProtocolClientConfig({
    profiles: defaultProtocolConfigs(), server: "node.example.com",
    credential: { email: "test@example.com", runtimePassword: "AAAAAAAAAAAAAAAAAAAAAA==", serverPassword: "AAAAAAAAAAAAAAAAAAAAAA==" },
    routePolicy
  });
}

test("sing-box keeps AI dependencies on AI DNS and routing without broad shared-provider suffixes", () => {
  const config = clientConfig({ rules: [{ match: "domain_suffix", value: "workos.com", action: "direct" }] });
  const aiRoute = config.route.rules.find((rule) => rule.outbound === "raylink-ai" && rule.domain);
  const aiDns = config.dns.rules.find((rule) => rule.server === "dns-ai" && rule.domain);
  for (const rule of [aiRoute, aiDns]) {
    assert.ok(rule.domain.includes("challenges.cloudflare.com"));
    assert.ok(rule.domain.includes("forwarder.workos.com"));
    assert.ok(rule.domain_suffix.includes("claude.com"));
    assert.ok(rule.domain_suffix.includes("claudeusercontent.com"));
    assert.ok(rule.domain_suffix.includes("oaistatsig.com"));
    for (const suffix of ["workos.com", "cloudflare.com", "workoscdn.com", "imgix.net"]) assert.ok(!rule.domain_suffix.includes(suffix));
  }
  assert.ok(config.route.rules.findIndex((rule) => rule.domain_suffix?.includes("workos.com") && rule.outbound === "direct") < config.route.rules.indexOf(aiRoute));
  assert.ok(config.dns.rules.findIndex((rule) => rule.domain_suffix?.includes("workos.com") && rule.server === "dns-domestic") < config.dns.rules.indexOf(aiDns));
});

test("smart subscription distinguishes system, domestic and AI DNS paths", () => {
  const config = clientConfig({ rules: [
    { match: "domain", value: "office.example.com", action: "direct", dns: "system" },
    { match: "domain", value: "cdn.example.com", action: "direct", dns: "domestic" },
    { match: "domain", value: "bot.example.com", action: "ai", dns: "remote" }
  ] });
  const resolver = (name) => config.dns.rules.find((rule) => rule.domain?.includes(name))?.server;
  assert.equal(resolver("office.example.com"), "dns-local");
  assert.equal(resolver("cdn.example.com"), "dns-domestic");
  assert.equal(resolver("bot.example.com"), "dns-ai");
  assert.equal(config.dns.servers.find((server) => server.tag === "dns-ai")?.detour, "raylink-ai");
  assert.equal(config.dns.rules.find((rule) => rule.domain_suffix?.includes("chatgpt.com"))?.server, "dns-ai");
});

test("mobile default and AI automatic selection use TCP candidates without dropping UDP choices", () => {
  const vless = defaultProtocolConfigs().find((profile) => profile.type === "vless");
  const config = buildMultiHostProtocolClientConfig({
    credential: { email: "test@example.com", runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d", serverPassword: "AAAAAAAAAAAAAAAAAAAAAA==" },
    hosts: [
      { id: "quic", address: "quic.example.com", protocols: [{ ...vless, enabled: true, transport: { type: "quic" }, tls: { mode: "certificate", serverName: "quic.example.com" } }] },
      ...["primary", "backup"].map((id) => ({ id, address: `${id}.example.com`, protocols: [{ ...vless, enabled: true }] }))
    ]
  });
  const group = (tag) => config.outbounds.find((outbound) => outbound.tag === tag);
  assert.equal(group("raylink-auto").default, "raylink-tcp");
  assert.equal(group("raylink-ai").default, "raylink-ai-stable");
  assert.deepEqual(group("raylink-ai-stable").outbounds, ["raylink-primary-vless", "raylink-backup-vless"]);
  assert.ok(group("raylink-auto").outbounds.includes("raylink-udp"));
  assert.equal(group("raylink-ai").interrupt_exist_connections, false);
  assert.ok(group("raylink-ai").outbounds.includes("raylink-backup-vless"), "AI exit can be explicitly pinned");
});
