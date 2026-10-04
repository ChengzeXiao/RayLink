import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-ai-egress-"));
  const options = { dbPath: join(directory, "raylink.db"), adminUsername: "admin",
    adminPassword: "test-password-123", subscriptionEncryptionKey: "ai-egress-test-key", seedDemoData: false };
  let store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, reopen(changes = {}) {
    store.close(); store = new RayLinkStore({ ...options, ...changes }); return store;
  } };
}

test("an invalid server Host rolls back the entire residential-to-server switch", async (t) => {
  const { store } = await fixture(t);
  store.updateAiUpstreamSettings({ enabled: true, server: "proxy.example.com", username: "owner", password: "retained-secret" });
  const upstream = store.aiUpstreamSettings();
  const policy = store.routingPolicy();
  assert.throws(() => store.updateAiEgressSettings({ mode: "server", aiExit: { mode: "pinned", hostId: "missing-host" } }),
    { code: "INVALID_AI_EXIT" });
  assert.deepEqual(store.aiUpstreamSettings(), upstream);
  assert.deepEqual(store.routingPolicy(), policy);
  assert.equal(store.aiUpstreamRuntimeSettings().password, "retained-secret");
});

test("AI egress rejects malformed or mixed-mode input without changing saved settings", async (t) => {
  const { store } = await fixture(t);
  const upstream = store.aiUpstreamSettings();
  const policy = store.routingPolicy();
  for (const input of [undefined, null, [], "server", {}, { mode: "direct" },
    { mode: "server", unknown: true }, { mode: "server", upstream: {} },
    { mode: "server", aiExit: null }, { mode: "server", aiExit: [] },
    { mode: "server", aiExit: { mode: "auto", unknown: true } },
    { mode: "server", aiExit: { mode: "auto", hostId: {} } },
    { mode: "residential", aiExit: { mode: "auto" } },
    { mode: "residential", upstream: null }, { mode: "residential", upstream: [] },
    { mode: "residential", upstream: "proxy.example.com" },
    { mode: "residential", upstream: { enabled: false } },
    { mode: "residential", upstream: { hostId: "local" } },
    { mode: "residential", upstream: { revision: 1 } },
    { mode: "residential", upstream: { insecure: true } }]) {
    assert.throws(() => store.updateAiEgressSettings(input), { code: "INVALID_AI_EGRESS", statusCode: 422 });
    assert.deepEqual(store.aiUpstreamSettings(), upstream);
    assert.deepEqual(store.routingPolicy(), policy);
  }
});

test("switching between server and residential exits preserves credentials and existing routing rules", async (t) => {
  const fixtureState = await fixture(t), { store } = fixtureState;
  const policy = store.updateRoutingPolicy({ mode: "global-proxy", rules: [
    { match: "domain", value: "ordinary.example.com", action: "direct", note: "preserve this rule" }
  ] });
  const residential = store.updateAiEgressSettings({ mode: "residential", upstream: {
    type: "https", server: "proxy.example.com", port: 443, username: "owner", password: "kept-private-password",
    tlsServerName: "proxy.example.com"
  } });
  assert.equal(residential.mode, "residential");
  assert.deepEqual(residential.aiExit, { mode: "pinned", hostId: "local" });
  assert.equal(residential.upstream.enabled, true);
  assert.equal(residential.upstream.passwordConfigured, true);
  assert.equal(residential.upstream.revision, 1);
  assert.doesNotMatch(JSON.stringify(residential), /kept-private-password|passwordEncrypted/);
  assert.equal(store.routingPolicy().mode, "smart");
  assert.deepEqual(store.routingPolicy().rules, policy.rules);
  const server = store.updateAiEgressSettings({ mode: "server", aiExit: { mode: "auto" } });
  assert.equal(server.mode, "server");
  assert.deepEqual(server.aiExit, { mode: "auto", hostId: null });
  assert.equal(server.upstream.enabled, false);
  assert.equal(server.upstream.passwordConfigured, true);
  assert.equal(server.upstream.revision, 2);
  assert.equal(store.routingPolicy().mode, "smart");
  assert.deepEqual(store.routingPolicy().rules, policy.rules);
  const reopened = fixtureState.reopen();
  const reenabled = reopened.updateAiEgressSettings({ mode: "residential" });
  assert.equal(reenabled.mode, "residential");
  assert.equal(reenabled.upstream.revision, 3);
  assert.deepEqual(reenabled.aiExit, { mode: "pinned", hostId: "local" });
  assert.equal(reopened.aiUpstreamRuntimeSettings().password, "kept-private-password");
  assert.deepEqual(reopened.routingPolicy().rules, policy.rules);
});

test("server mode needs no residential parameters and preserves the current Host and routing mode when omitted", async (t) => {
  const { store } = await fixture(t);
  const host = store.createRemoteHost({ name: "Chosen server", address: "203.0.113.8", region: "tokyo" }).host;
  const policy = store.updateRoutingPolicy({ mode: "global-proxy", aiExit: { mode: "pinned", hostId: host.id }, rules: [
    { match: "domain", value: "ordinary.example.com", action: "direct" }
  ] });
  const result = store.updateAiEgressSettings({ mode: "server" });
  assert.equal(result.mode, "server");
  assert.deepEqual(result.aiExit, { mode: "pinned", hostId: host.id });
  assert.equal(result.upstream.enabled, false);
  assert.equal(result.upstream.server, "");
  assert.equal(result.upstream.passwordConfigured, false);
  assert.equal(result.upstream.revision, 0);
  assert.deepEqual(store.routingPolicy(), policy);
});

test("replaying an unchanged exit choice does not add configuration revisions", async (t) => {
  const { store } = await fixture(t);
  const server = store.updateAiEgressSettings({ mode: "server", aiExit: { mode: "auto" } });
  assert.deepEqual(store.updateAiEgressSettings({ mode: "server" }), server);
  const residential = store.updateAiEgressSettings({ mode: "residential", upstream: {
    server: "proxy.example.com", username: "owner", password: "same-secret"
  } });
  for (const input of [{ mode: "residential" }, { mode: "residential", upstream: {} },
    { mode: "residential", upstream: { server: "proxy.example.com", password: "", clearPassword: false } },
    { mode: "residential", upstream: { password: "same-secret" } }]) {
    assert.deepEqual(store.updateAiEgressSettings(input), residential);
  }
  const disabled = store.updateAiEgressSettings({ mode: "server" });
  assert.equal(disabled.upstream.revision, 2);
  assert.deepEqual(store.updateAiEgressSettings({ mode: "server" }), disabled);
});

test("server mode can recover from unavailable residential credentials without discarding the stored credential", async (t) => {
  const fixtureState = await fixture(t), { store } = fixtureState;
  store.updateAiEgressSettings({ mode: "residential", upstream: {
    server: "proxy.example.com", username: "owner", password: "recoverable-secret"
  } });
  const wrongKey = fixtureState.reopen({ subscriptionEncryptionKey: "different-fixture-key" });
  const before = wrongKey.aiUpstreamSettings();
  assert.throws(() => wrongKey.updateAiEgressSettings({ mode: "server", aiExit: { mode: "pinned", hostId: "missing-host" } }),
    { code: "INVALID_AI_EXIT" });
  assert.deepEqual(wrongKey.aiUpstreamSettings(), before);
  const server = wrongKey.updateAiEgressSettings({ mode: "server", aiExit: { mode: "auto" } });
  assert.equal(server.upstream.enabled, false);
  assert.equal(server.upstream.passwordConfigured, true);
  assert.equal(server.upstream.revision, 2);
  assert.equal(wrongKey.runtimeSnapshot("local").aiUpstream.enabled, false);
  assert.deepEqual(wrongKey.updateAiEgressSettings({ mode: "server" }), server);
  assert.throws(() => wrongKey.updateAiEgressSettings({ mode: "residential" }), { code: "AI_UPSTREAM_SECRET_UNAVAILABLE" });
  assert.deepEqual(wrongKey.aiUpstreamSettings(), server.upstream);
  const recovered = fixtureState.reopen();
  recovered.updateAiEgressSettings({ mode: "residential" });
  assert.equal(recovered.aiUpstreamRuntimeSettings().password, "recoverable-secret");
});

test("invalid residential parameters leave server selection and routing rules untouched", async (t) => {
  const { store } = await fixture(t);
  const policy = store.updateRoutingPolicy({ mode: "direct", rules: [
    { match: "domain", value: "ordinary.example.com", action: "direct" }
  ] });
  const upstream = store.aiUpstreamSettings();
  for (const input of [{ mode: "residential" }, { mode: "residential", upstream: { server: "https://proxy.example.com" } },
    { mode: "residential", upstream: { server: "proxy.example.com", username: "owner" } }]) {
    assert.throws(() => store.updateAiEgressSettings(input), { code: "INVALID_AI_UPSTREAM", statusCode: 422 });
    assert.deepEqual(store.aiUpstreamSettings(), upstream);
    assert.deepEqual(store.routingPolicy(), policy);
  }
});

test("deployment metadata reports its published exit mode without decrypting residential credentials", async (t) => {
  const fixtureState = await fixture(t), { store } = fixtureState;
  const server = store.createDeployment({ version: "server-fixture", configJson: {
    inbounds: [], outbounds: [{ type: "direct", tag: "direct" }]
  }, checksum: "server-checksum", eligibleUsers: 0 });
  const residential = store.createDeployment({ version: "residential-fixture", configJson: {
    inbounds: [], outbounds: [{ type: "socks", tag: "ai-residential", password: "snapshot-private-password" }]
  }, checksum: "residential-checksum", eligibleUsers: 0 });
  const unknown = store.createDeployment({ version: "unknown-fixture", configJson: {}, checksum: "unknown-checksum", eligibleUsers: 0 });
  const reopened = fixtureState.reopen({ subscriptionEncryptionKey: "different-fixture-key" });
  assert.deepEqual(reopened.deploymentSnapshotMetadata(server), { checksum: "server-checksum", hostSnapshots: [], aiEgressMode: "server" });
  assert.deepEqual(reopened.deploymentSnapshotMetadata(residential), { checksum: "residential-checksum", hostSnapshots: [], aiEgressMode: "residential" });
  assert.deepEqual(reopened.deploymentSnapshotMetadata(unknown), { checksum: "unknown-checksum", hostSnapshots: [], aiEgressMode: null });
  assert.doesNotMatch(JSON.stringify(reopened.deploymentSnapshotMetadata(residential)), /snapshot-private-password|password|encrypted/i);
  assert.throws(() => reopened.deploymentSnapshot(residential), { code: "AI_UPSTREAM_SECRET_UNAVAILABLE" });
});
