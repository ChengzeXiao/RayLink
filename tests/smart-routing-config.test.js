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

test("smart sing-box routes unclassified traffic through a manual proxy or direct choice", () => {
  const config = clientConfig({ mode: "smart" });
  const unknown = config.outbounds.find((outbound) => outbound.tag === "raylink-unknown");
  assert.deepEqual(unknown, {
    type: "selector", tag: "raylink-unknown", outbounds: ["raylink-auto", "direct"],
    default: "raylink-auto", interrupt_exist_connections: false
  });
  assert.equal(config.route.final, "raylink-unknown");
  assert.equal(config.route.rules.find((rule) => rule.rule_set === "geoip-cn")?.outbound, "direct");
  for (const [mode, final] of [["global-proxy", "raylink-auto"], ["direct", "direct"]]) {
    const other = clientConfig({ mode });
    assert.equal(other.route.final, final);
    assert.ok(!other.outbounds.some((outbound) => outbound.tag === "raylink-unknown"));
  }
});

test("sing-box keeps AI dependencies on AI DNS and routing without broad shared-provider suffixes", () => {
  const config = clientConfig({ rules: [{ match: "domain_suffix", value: "workos.com", action: "direct" }] });
  const aiRoute = config.route.rules.find((rule) => rule.outbound === "raylink-ai" && rule.domain);
  const aiDns = config.dns.rules.find((rule) => rule.server === "dns-ai" && rule.domain);
  for (const rule of [aiRoute, aiDns]) {
    assert.ok(rule.domain_suffix.includes("challenges.cloudflare.com"));
    assert.ok(rule.domain.includes("forwarder.workos.com"));
    for (const host of ["aistudio.google.com", "notebooklm.google.com", "copilot.microsoft.com", "copilot.cloud.microsoft", "copilot-proxy.githubusercontent.com", "origin-tracker.githubusercontent.com"]) assert.ok(rule.domain.includes(host));
    for (const suffix of ["githubcopilot.com", "openrouter.ai", "mistral.ai", "cohere.com"]) assert.ok(rule.domain_suffix.includes(suffix));
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

test("mobile default uses TCP while AI recovery retains every enabled transport", () => {
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
  assert.deepEqual(group("raylink-ai-stable").outbounds, ["raylink-primary-vless", "raylink-backup-vless", "raylink-quic-vless"]);
  assert.ok(group("raylink-auto").outbounds.includes("raylink-udp"));
  assert.equal(group("raylink-ai").interrupt_exist_connections, false);
  assert.ok(group("raylink-ai").outbounds.includes("raylink-backup-vless"), "AI exit can be explicitly pinned");
});

test("manual AI selection can only use authorized protocols on the pinned Host", () => {
  const profiles = defaultProtocolConfigs().filter((profile) => ["vless", "hysteria2"].includes(profile.type))
    .map((profile) => ({ ...profile, enabled: true }));
  const build = (hostId) => buildMultiHostProtocolClientConfig({
    credential: { email: "test@example.com", runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d", runtimePassword: "fixture", serverPassword: "AAAAAAAAAAAAAAAAAAAAAA==" },
    hosts: ["primary", "other-region"].map((id) => ({ id, address: `${id}.example.com`, protocols: profiles })),
    routePolicy: { aiSelection: "manual", aiExit: { mode: "pinned", hostId } }
  });
  const config = build("primary");
  const ai = config.outbounds.find((outbound) => outbound.tag === "raylink-ai");
  assert.deepEqual(ai.outbounds, ["raylink-primary-vless", "raylink-primary-hysteria2"]);
  assert.equal(ai.default, "raylink-primary-vless");
  assert.equal(ai.interrupt_exist_connections, false);
  assert.deepEqual(config.outbounds.find((outbound) => outbound.tag === "raylink-ai-stable").outbounds, ai.outbounds,
    "Host membership must remain available to the other full-profile exporters");
  assert.ok(config.outbounds.find((outbound) => outbound.tag === "raylink-auto").outbounds.includes("raylink-other-region-vless"),
    "Ordinary traffic retains the other authorized Host");
  const missing = build("no-longer-authorized");
  assert.ok(!missing.outbounds.some((outbound) => outbound.tag === "raylink-ai"));
  assert.equal(missing.route.rules.find((rule) => rule.domain_suffix?.includes("claude.ai"))?.action, "reject");
  assert.equal(missing.dns.rules.find((rule) => rule.domain_suffix?.includes("claude.ai"))?.action, "reject");
});
