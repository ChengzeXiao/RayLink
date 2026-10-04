import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-ai-upstream-"));
  const options = { dbPath: join(directory, "raylink.db"), adminUsername: "admin",
    adminPassword: "test-password-123", subscriptionEncryptionKey: "upstream-test-master", seedDemoData: false };
  let store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, reopen() { store.close(); store = new RayLinkStore(options); return store; }, options };
}

test("AI upstream settings persist without exposing their password and enable a fixed local Host with existing rules", async (t) => {
  const fixtureState = await fixture(t), { store } = fixtureState;
  assert.deepEqual(store.aiUpstreamSettings(), {
    enabled: false, hostId: "local", type: "socks5", server: "", port: 1080,
    username: "", tlsServerName: "", passwordConfigured: false, revision: 0
  });
  const rules = [{ match: "domain", value: "example.com", action: "direct" }];
  const oldPolicy = store.updateRoutingPolicy({ mode: "global-proxy", rules });
  const saved = store.updateAiUpstreamSettings({ enabled: true, type: "https", server: "proxy.example.com", port: 443,
    username: "account", password: " private-password ", tlsServerName: "proxy.example.com" });
  assert.deepEqual(saved, { enabled: true, hostId: "local", type: "https", server: "proxy.example.com", port: 443,
    username: "account", tlsServerName: "proxy.example.com", passwordConfigured: true, revision: 1 });
  assert.doesNotMatch(JSON.stringify(saved), /private-password|encrypted/i);
  assert.deepEqual(store.routingPolicy(), { ...oldPolicy, mode: "smart", aiExit: { mode: "pinned", hostId: "local" } });
  assert.equal(store.aiUpstreamRuntimeSettings().password, " private-password ");
  assert.equal(store.runtimeSnapshot("local").aiUpstream.password, " private-password ");
  const remote = store.createRemoteHost({ name: "Other Host", address: "203.0.113.8", region: "tokyo" }).host;
  assert.equal(Object.hasOwn(store.runtimeSnapshot(remote.id), "aiUpstream"), false);
  assert.doesNotMatch(JSON.stringify(store.listClientHosts()), /private-password|passwordEncrypted/);
  assert.deepEqual(fixtureState.reopen().aiUpstreamSettings(), saved);
  assert.equal(fixtureState.store.aiUpstreamRuntimeSettings().password, " private-password ");
});

test("AI upstream partial changes preserve credentials, count only effective changes, and can disable without releasing the Host pin", async (t) => {
  const { store } = await fixture(t);
  const first = store.updateAiUpstreamSettings({ enabled: true, server: "127.0.0.1", username: "user", password: " secret " });
  assert.equal(first.revision, 1);
  for (const input of [{}, { password: "" }, { password: " secret " }, { clearPassword: false }, { server: "127.0.0.1" }]) {
    assert.deepEqual(store.updateAiUpstreamSettings(input), first);
    assert.equal(store.aiUpstreamRuntimeSettings().password, " secret ");
  }
  const changed = store.updateAiUpstreamSettings({ port: 1081 });
  assert.equal(changed.revision, 2);
  assert.equal(store.aiUpstreamRuntimeSettings().password, " secret ");
  const before = store.aiUpstreamSettings();
  for (const input of [{ clearPassword: true }, { clearPassword: true, password: "new" }, { username: "" }]) {
    assert.throws(() => store.updateAiUpstreamSettings(input), { code: "INVALID_AI_UPSTREAM", statusCode: 422 });
    assert.deepEqual(store.aiUpstreamSettings(), before);
  }
  const whitelist = store.updateAiUpstreamSettings({ username: "", clearPassword: true });
  assert.equal(whitelist.passwordConfigured, false);
  assert.equal(whitelist.revision, 3);
  assert.equal(store.aiUpstreamRuntimeSettings().password, "");
  const policy = store.routingPolicy();
  const disabled = store.updateAiUpstreamSettings({ enabled: false });
  assert.equal(disabled.revision, 4);
  assert.deepEqual(store.routingPolicy(), policy);
  assert.deepEqual(store.updateRoutingPolicy({ mode: "direct", aiExit: { mode: "auto" } }).aiExit, { mode: "auto", hostId: null });
});

test("an enabled AI upstream locks smart routing to the local Host without discarding custom rules", async (t) => {
  const { store } = await fixture(t);
  store.updateAiUpstreamSettings({ enabled: true, server: "proxy.example.com" });
  const policy = store.routingPolicy();
  for (const patch of [
    { mode: "direct" }, { mode: "global-proxy" },
    { mode: "smart", aiExit: { mode: "auto" } }, { mode: "smart", aiExit: { mode: "pinned", hostId: "other" } }
  ]) {
    assert.throws(() => store.updateRoutingPolicy(patch), { code: "AI_UPSTREAM_ROUTING_CONFLICT", statusCode: 409 });
    assert.deepEqual(store.routingPolicy(), policy);
  }
  const updated = store.updateRoutingPolicy({ mode: "smart", rules: [{ match: "domain", value: "example.com", action: "direct" }] });
  assert.equal(updated.rules.length, 1);
  assert.deepEqual(updated.aiExit, policy.aiExit);
  assert.equal(store.aiUpstreamSettings().revision, 1);
});

test("AI upstream credentials remain encrypted in saved settings and deployment history while snapshots restore the exact Runtime config", async (t) => {
  const fixtureState = await fixture(t), { store } = fixtureState;
  const password = "upstream-history-private-password";
  store.updateAiUpstreamSettings({ enabled: true, server: "proxy.example.com", username: "owner", password });
  const stored = store.db.prepare("SELECT value FROM settings WHERE key='ai_upstream'").get().value;
  assert.doesNotMatch(stored, /upstream-history-private-password/);
  const config = { inbounds: [], outbounds: [
    { type: "socks", tag: "ai-residential", server: "proxy.example.com", password, version: "5", username: "owner" },
    { type: "socks", tag: "legacy-other", password: "existing-legacy-credential" }
  ], route: { final: "direct" } };
  const hostSnapshots = [{ hostId: "fixture-other-host", config, checksum: "fixture-checksum", protocols: [] }];
  const id = store.createDeployment({ version: "upstream-1", configJson: config, checksum: "fixture-checksum", eligibleUsers: 0, hostSnapshots });
  const raw = store.db.prepare("SELECT config_json FROM deployments WHERE id=?").get(id).config_json;
  assert.doesNotMatch(raw, /upstream-history-private-password/);
  assert.match(raw, /existing-legacy-credential/, "unrelated legacy fields retain their established representation");
  assert.equal(config.outbounds[0].password, password, "persisting a snapshot must not alter the live candidate");
  assert.equal(hostSnapshots[0].config.outbounds[0].password, password);
  assert.doesNotMatch(JSON.stringify(store.listDeployments()), /upstream-history-private-password|existing-legacy-credential/);
  const reopened = fixtureState.reopen();
  assert.equal(reopened.aiUpstreamRuntimeSettings().password, password);
  const restored = reopened.deploymentSnapshot(id);
  assert.equal(JSON.stringify(restored.config), JSON.stringify(config), "rollback must preserve serialization order and checksum inputs");
  assert.equal(JSON.stringify(restored.hostSnapshots), JSON.stringify(hostSnapshots));
});

test("AI upstream rejects invalid fields and enforces UTF-8 credential limits without changing saved configuration", async (t) => {
  const { store } = await fixture(t);
  const prior = store.aiUpstreamSettings();
  const invalidInputs = [null, [], "proxy", { hostId: "remote" }, { enabled: "true" }, { type: "socks4" },
    { port: "1080" }, { port: 0 }, { port: 65536 }, { port: 1.5 }, { enabled: true },
    { server: "https://proxy.example.com" }, { server: "user:pass@proxy.example.com" }, { server: "proxy.example.com/path" },
    { server: "proxy.example.com\n" }, { server: "bad name.example" }, { server: "-bad.example" }, { server: "fe80::1%lo0" },
    { tlsServerName: "*.example.com" }, { tlsServerName: "https://example.com" }, { tlsServerName: "example.com\r\n" },
    { tlsServerName: "127.0.0.1" }, { tlsServerName: "::1" },
    { insecure: true }, { passwordConfigured: true }, { revision: 9 }, { clearPassword: "true" },
    { username: "user" }, { password: "secret" }, { username: "用".repeat(86), password: "secret" },
    { username: "user", password: "密".repeat(86) }, { username: "user", password: null },
    { type: "http", username: "name:ambiguous", password: "secret" }, { type: "https", username: "name:ambiguous", password: "secret" }];
  for (const input of invalidInputs) {
    assert.throws(() => store.updateAiUpstreamSettings(input), { code: "INVALID_AI_UPSTREAM", statusCode: 422 }, JSON.stringify(input));
    assert.deepEqual(store.aiUpstreamSettings(), prior);
  }
  const valid = store.updateAiUpstreamSettings({ enabled: true, type: "https", server: "::1", tlsServerName: "proxy.example.com",
    username: "用".repeat(85), password: "密".repeat(85) });
  assert.equal(valid.server, "::1");
  assert.equal(valid.revision, 1);
  assert.equal(store.aiUpstreamRuntimeSettings().password, "密".repeat(85));
  const socks = store.updateAiUpstreamSettings({ type: "socks5", username: "name:allowed", password: "pass:allowed" });
  assert.equal(socks.username, "name:allowed");
  assert.equal(store.aiUpstreamRuntimeSettings().password, "pass:allowed");
});

test("an unavailable encryption key fails closed without exposing secrets and explicit replacement credentials recover the setting", async (t) => {
  const fixtureState = await fixture(t);
  fixtureState.store.updateAiUpstreamSettings({ enabled: true, server: "proxy.example.com", username: "owner", password: "old-private-password" });
  fixtureState.options.subscriptionEncryptionKey = "replacement-master-key";
  const store = fixtureState.reopen();
  assert.equal(store.aiUpstreamSettings().passwordConfigured, true);
  assert.throws(() => store.aiUpstreamRuntimeSettings(), (error) => {
    assert.equal(error.code, "AI_UPSTREAM_SECRET_UNAVAILABLE");
    assert.doesNotMatch(error.message, /old-private-password|replacement-master-key/);
    return true;
  });
  assert.throws(() => store.runtimeSnapshot("local"), { code: "AI_UPSTREAM_SECRET_UNAVAILABLE" });
  assert.equal(store.updateAiUpstreamSettings({ password: "new-private-password" }).revision, 2);
  assert.equal(store.aiUpstreamRuntimeSettings().password, "new-private-password");
});

test("upstream activation and its required Host pin commit atomically when a settings write fails", async (t) => {
  const { store } = await fixture(t);
  const original = store.updateRoutingPolicy({ mode: "direct", rules: [{ match: "domain", value: "example.com", action: "direct" }] });
  store.db.exec(`CREATE TRIGGER fixture_reject_pin BEFORE UPDATE ON settings WHEN NEW.key='routing_policy'
    BEGIN SELECT RAISE(ABORT,'fixture write failure'); END`);
  assert.throws(() => store.updateAiUpstreamSettings({ enabled: true, server: "proxy.example.com", username: "owner", password: "fixture-password" }));
  assert.equal(store.aiUpstreamSettings().enabled, false);
  assert.equal(store.aiUpstreamSettings().revision, 0);
  assert.equal(store.aiUpstreamSettings().passwordConfigured, false);
  assert.deepEqual(store.routingPolicy(), original);
});

test("deployment credentials cannot be replayed between snapshot identities and corrupted history fails without leaking plaintext", async (t) => {
  const { store } = await fixture(t);
  const config = { inbounds: [], outbounds: [{ tag: "ai-residential", type: "socks", server: "proxy.example.com", password: "snapshot-secret-value" }] };
  const first = store.createDeployment({ version: "first", configJson: config, checksum: "first", eligibleUsers: 0 });
  const second = store.createDeployment({ version: "second", configJson: config, checksum: "second", eligibleUsers: 0 });
  const source = store.db.prepare("SELECT config_json FROM deployments WHERE id=?").get(first).config_json;
  store.db.prepare("UPDATE deployments SET config_json=? WHERE id=?").run(source, second);
  assert.throws(() => store.deploymentSnapshot(second), (error) => {
    assert.equal(error.code, "AI_UPSTREAM_SECRET_UNAVAILABLE");
    assert.doesNotMatch(error.message, /snapshot-secret-value/);
    return true;
  });
  assert.equal(store.deploymentSnapshot(first).config.outbounds[0].password, "snapshot-secret-value");
});


test("disabled upstream never requires its stored secret for Runtime snapshots and re-enabling preserves credentials", async (t) => {
  const { store } = await fixture(t);
  const policy = store.routingPolicy();
  store.updateAiUpstreamSettings({ enabled: false, server: "proxy.example.com", username: "owner", password: "retained-password" });
  assert.equal(store.aiUpstreamRuntimeSettings().password, "");
  assert.equal(store.runtimeSnapshot("local").aiUpstream.password, "");
  assert.deepEqual(store.routingPolicy(), policy);
  store.updateAiUpstreamSettings({ port: 1081 });
  store.updateAiUpstreamSettings({ enabled: true });
  assert.equal(store.aiUpstreamRuntimeSettings().password, "retained-password");
  store.updateAiUpstreamSettings({ enabled: false });
  const row = JSON.parse(store.db.prepare("SELECT value FROM settings WHERE key='ai_upstream'").get().value);
  row.passwordEncrypted = "unavailable-fixture-secret";
  store.db.prepare("UPDATE settings SET value=? WHERE key='ai_upstream'").run(JSON.stringify(row));
  assert.equal(store.aiUpstreamSettings().passwordConfigured, true);
  assert.equal(store.runtimeSnapshot("local").aiUpstream.enabled, false);
  assert.equal(store.aiUpstreamRuntimeSettings().password, "");
  assert.throws(() => store.updateAiUpstreamSettings({ enabled: true }), { code: "AI_UPSTREAM_SECRET_UNAVAILABLE" });
});
