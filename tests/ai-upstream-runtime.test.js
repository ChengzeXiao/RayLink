import assert from "node:assert/strict";
import test from "node:test";
import { buildSingBoxConfig } from "../server/singbox/config.js";
import { buildMultiHostProtocolClientConfig, defaultProtocolConfigs } from "../server/singbox/protocol-catalog.js";
import { RuntimeManager } from "../server/singbox/runtime-manager.js";
import { isAiUpstreamDomain } from "../server/routing/ai-upstream-domains.js";

const upstream = { enabled: true, hostId: "local", type: "socks5", server: "upstream.example", port: 1080,
  username: "fixture-user", password: "fixture-secret", tlsServerName: "upstream.example", revision: 1 };
const snapshot = aiUpstream => ({ host: { id: "local", kind: "local", runtimeVersion: "1.14.2", region: "us" },
  protocols: [], users: [], masterPassword: "fixture", aiUpstream });

test("enabled AI residential upstream is TCP-only and never adds a direct fallback", () => {
  for (const type of ["socks5", "http", "https"]) {
    const config = buildSingBoxConfig(snapshot({ ...upstream, type }));
    const outbound = config.outbounds.find(item => item.tag === "ai-residential");
    assert.ok(outbound);
    assert.equal(outbound.type, type === "socks5" ? "socks" : "http");
    assert.equal(outbound.username, upstream.username);
    assert.equal(outbound.password, upstream.password);
    if (type === "socks5") { assert.equal(outbound.version, "5"); assert.equal(outbound.network, "tcp"); }
    if (type === "https") assert.deepEqual(outbound.tls, { enabled: true, server_name: "upstream.example" });
    else assert.equal(outbound.tls, undefined);
    assert.equal(config.route.final, "direct");
    assert.equal(config.outbounds.some(item => ["selector", "urltest"].includes(item.type)), false);
    const resolve = config.route.rules.findIndex(item => item.action === "resolve");
    const ai = config.route.rules.findIndex(item => item.outbound === "ai-residential");
    assert.ok(ai >= 0 && ai < resolve);
    assert.ok(config.route.rules.some(item => item.network === "udp" && item.action === "reject" && item.domain_suffix?.includes("claude.ai")));
    assert.equal(config.route.rules.some(item => item.ip_cidr || item.port || item.invert), false, "do not sweep shared DNS/IP-only traffic into residential egress");
  }
});

test("disabled upstream preserves Runtime output and remote Hosts never receive local credentials", () => {
  assert.deepEqual(buildSingBoxConfig(snapshot({ ...upstream, enabled: false })), buildSingBoxConfig(snapshot(undefined)));
  assert.throws(() => buildSingBoxConfig({ ...snapshot(upstream), host: { id: "remote", kind: "remote", runtimeVersion: "1.14.2" } }), { code: "INVALID_AI_UPSTREAM_RUNTIME" });
});

test("AI client routing preserves original domain instead of resolving it before the proxy", () => {
  const config = buildMultiHostProtocolClientConfig({ credential: { runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d", runtimePassword: "fixture" },
    hosts: [{ id: "local", address: "node.example", protocols: defaultProtocolConfigs().filter(item => item.type === "vless").map(item => ({ ...item, enabled: true })) }],
    routePolicy: { mode: "smart", aiExit: { mode: "pinned", hostId: "local" } } });
  const aiRules = config.route.rules.filter(item => item.domain_suffix?.includes("claude.ai"));
  assert.ok(aiRules.some(item => item.outbound === "raylink-ai"));
  assert.equal(aiRules.some(item => item.action === "resolve"), false);
});

test("residential matching includes AI services but excludes ordinary Google, shared login and challenges", () => {
  for (const domain of ["claude.ai", "API.Anthropic.com.", "chatgpt.com", "api.openai.com", "gemini.google.com", "aistudio.google.com", "copilot.microsoft.com"]) assert.ok(isAiUpstreamDomain(domain), domain);
  for (const domain of ["google.com", "www.google.com", "accounts.google.com", "mail.google.com", "gmail.com", "youtube.com", "www.youtube.com",
    "github.com", "login.microsoftonline.com", "challenges.cloudflare.com", "hagen.challenges.cloudflare.com", "cdn.workos.com", "forwarder.workos.com", "images.workoscdn.com", "claude.ai.evil.example", "https://claude.ai", "a..claude.ai", ".claude.ai", "127.0.0.1", ""]) {
    assert.equal(isAiUpstreamDomain(domain), false, domain);
  }
});

test("residential publication errors never persist or throw upstream credentials", async () => {
  const password = 'fixture-secret/?"sensitive';
  const config = buildSingBoxConfig(snapshot({ ...upstream, password }));
  const recorded = [];
  const store = { createDeployment: () => "fixture", finishDeployment: (_id, outcome) => recorded.push(outcome) };
  const adapter = { publish: async () => { throw Object.assign(new Error(`rejected ${password} ${encodeURIComponent(password)} ${JSON.stringify(password)}`),
    { code: "NATIVE_REJECTED", statusCode: 502, rolledBack: false, rollbackError: `rollback ${password}` }); } };
  const manager = new RuntimeManager({ store, adapter });
  await assert.rejects(manager.publishCompiled({ config, configText: JSON.stringify(config) }), error => {
    assert.equal(error.code, "NATIVE_REJECTED"); assert.equal(error.statusCode, 502);
    assert.equal(error.rolledBack, false);
    assert.ok(error.message.includes("[redacted]"));
    assert.ok(!JSON.stringify(error).includes("fixture-secret"));
    assert.ok(!error.stack.includes("fixture-secret"));
    return true;
  });
  assert.equal(recorded.length, 1); assert.equal(recorded[0].status, "failed");
  assert.ok(!JSON.stringify(recorded).includes("fixture-secret"));
});

test("disabling residential egress still redacts the previous proxy password from rollback errors", async () => {
  const previous = buildSingBoxConfig(snapshot(upstream));
  const recorded = [];
  const store = { listDeployments: () => [{ id: "previous", status: "active" }], deploymentSnapshot: () => ({ config: previous }),
    createDeployment: () => "new", finishDeployment: (_id, outcome) => recorded.push(outcome) };
  const adapter = { publish: async () => { throw Object.assign(new Error("restart failed"), { rollbackError: `previous ${upstream.password}` }); } };
  const manager = new RuntimeManager({ store, adapter });
  await assert.rejects(manager.publishCompiled({ config: buildSingBoxConfig(snapshot(undefined)) }), error => {
    assert.equal(error.rollbackError, "previous [redacted]"); return true;
  });
  assert.ok(!JSON.stringify(recorded).includes(upstream.password));
});
