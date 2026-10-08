import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";
import { buildSingBoxConfig } from "../server/singbox/config.js";
import { DatabaseSync } from "node:sqlite";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-identity-"));
  let instant = Date.now();
  const options = { dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "usage-identity-password", seedDemoData: false, clock: () => new Date(instant) };
  const store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const create = (email, nodeScope = ["all"]) => store.createUser({ name: "Usage User", email, quotaGb: 10, nodeScope, portalStatus: "active", expiresAt: "2099-12-31" });
  let sequence = 0;
  const sample = (hostId, name, bytes, overrides = {}) => store.recordUsageSnapshot(hostId, {
    sampleId: `identity-sample-${++sequence}`, runtimeInstanceId: "identity-runtime", users: [{ name, uplinkBytes: bytes, downlinkBytes: 0 }], ...overrides
  });
  return { store, create, sample, options, time: () => instant, setTime: value => { instant = value; } };
}

test("email edits and reuse cannot transfer an existing Runtime counter to another User", async (t) => {
  const { store, create, sample } = await fixture(t);
  const original = create("before@example.test");
  assert.equal(sample("local", original.email, 1_000).appliedBytes, 1_000);
  const runtimeBefore = buildSingBoxConfig(store.runtimeSnapshot()).inbounds[0].users[0].name;
  store.updateUser(original.id, { email: "after@example.test" });
  assert.equal(sample("local", original.email, 1_300).appliedBytes, 300);
  const replacement = create(original.email);
  assert.equal(sample("local", original.email, 1_500).appliedBytes, 200);
  assert.equal(store.getUser(original.id).usedGb * 1024 ** 3, 1_500);
  assert.equal(store.getUser(replacement.id).usedGb, 0);
  const names = buildSingBoxConfig(store.runtimeSnapshot()).inbounds[0].users.map(user => user.name).filter(name => name !== "raylink-probe@internal");
  assert.ok(names.includes(runtimeBefore), "renaming an account must preserve its Runtime identity");
  assert.equal(new Set(names).size, 2);
  const replacementName = store.clientCredential(replacement.id).runtimeName;
  assert.equal(sample("local", replacementName, 250).appliedBytes, 250);
  assert.equal(store.getUser(replacement.id).usedGb * 1024 ** 3, 250);
});

test("two aliases for the same User and Runtime cannot charge one counter twice", async (t) => {
  const { store, create, sample } = await fixture(t);
  const user = create("alias@example.test");
  const runtimeName = store.clientCredential(user.id).runtimeName;
  assert.equal(sample("local", user.email, 1_000).appliedBytes, 1_000);
  assert.equal(sample("local", runtimeName, 1_000).appliedBytes, 0);
  assert.equal(sample("local", user.email, 1_200).appliedBytes, 200);
  assert.equal(store.getUser(user.id).usedGb * 1024 ** 3, 1_200);
});

test("remote usage only charges historically applied Host members, including delayed samples after scope removal", async (t) => {
  const { store, create, sample, time, setTime } = await fixture(t);
  const authorized = create("authorized@example.test", ["us"]);
  const other = create("other@example.test", ["sg"]);
  const remote = store.createRemoteHost({ name: "US Host", address: "192.0.2.17", region: "us" });
  store.enrollNode(remote.enrollmentToken);
  store.updateHostProtocolConfig(remote.host.id, "vmess", { enabled: true });
  const apply = () => {
    const config = buildSingBoxConfig(store.runtimeSnapshot(remote.host.id));
    store.queueNodeTask(remote.host.id, "publish-config", { configText: JSON.stringify(config) });
    const task = store.nextNodeTask(remote.host.id);
    store.completeNodeTask(remote.host.id, task.id, { attempt: task.attempt, status: "succeeded" });
  };
  apply();
  const appliedAt = time();
  assert.equal(sample(remote.host.id, authorized.email, 999, { observedAt: new Date(appliedAt - 30 * 60_000).toISOString() }).appliedBytes, 0, "samples before any applied authorization are not billable");
  assert.equal(sample(remote.host.id, authorized.email, 1_000).appliedBytes, 1_000);
  assert.equal(sample(remote.host.id, other.email, 1_000).appliedBytes, 0);
  assert.equal(store.getUser(other.id).usedGb, 0);
  store.updateUser(authorized.id, { nodeScope: ["sg"] });
  apply();
  setTime(appliedAt + 10 * 60_000);
  assert.equal(sample(remote.host.id, authorized.email, 1_300).appliedBytes, 0, "samples observed after a Host grant was revoked are not billable");
  assert.equal(sample(remote.host.id, authorized.email, 1_300, { observedAt: new Date(appliedAt + 60_000).toISOString() }).appliedBytes, 300, "account for in-flight old Runtime samples after a legitimate scope change");
});

test("legacy migration preserves installed usernames, alias ownership and applied Host history across reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-identity-upgrade-"));
  const options = { dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "identity-upgrade-password", seedDemoData: false };
  let store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const user = store.createUser({ name: "Legacy User", email: "legacy@example.test", quotaGb: 10, nodeScope: ["all"], portalStatus: "active", expiresAt: "2099-12-31" });
  const remote = store.createRemoteHost({ name: "Legacy Host", address: "192.0.2.9", region: "us" });
  store.enrollNode(remote.enrollmentToken);
  store.updateHostProtocolConfig(remote.host.id, "vmess", { enabled: true });
  const config = buildSingBoxConfig(store.runtimeSnapshot(remote.host.id));
  config.inbounds[0].users.find(entry => entry.uuid === store.clientCredential(user.id).runtimeUuid).name = user.email;
  store.queueNodeTask(remote.host.id, "publish-config", { configText: JSON.stringify(config) });
  const task = store.nextNodeTask(remote.host.id);
  store.completeNodeTask(remote.host.id, task.id, { attempt: task.attempt, status: "succeeded" });
  store.recordUsageSnapshot(remote.host.id, { sampleId: "legacy-initial-usage", runtimeInstanceId: "legacy-runtime", users: [{ name: user.email, uplinkBytes: 100, downlinkBytes: 0 }] });
  store.close();
  // Previously released database had no persistent Runtime identity or Host
  // authorization index. Retained completed tasks are the migration evidence.
  const legacy = new DatabaseSync(options.dbPath);
  legacy.exec("UPDATE users SET runtime_name=NULL; DELETE FROM runtime_identity_aliases; DELETE FROM host_usage_authorizations; DELETE FROM settings WHERE key='runtime_identity_history_migrated'");
  legacy.close();
  store = new RayLinkStore(options);
  assert.equal(store.clientCredential(user.id).runtimeName, user.email);
  store.updateUser(user.id, { email: "renamed@example.test" });
  const replacement = store.createUser({ name: "Replacement", email: user.email, quotaGb: 10, nodeScope: ["all"], portalStatus: "active", expiresAt: "2099-12-31" });
  const late = store.recordUsageSnapshot(remote.host.id, { sampleId: "legacy-late-usage", runtimeInstanceId: "legacy-runtime", users: [{ name: user.email, uplinkBytes: 150, downlinkBytes: 0 }] });
  assert.equal(late.appliedBytes, 50);
  assert.equal(store.getUser(user.id).usedGb * 1024 ** 3, 150);
  assert.equal(store.getUser(replacement.id).usedGb, 0);
  assert.equal(buildSingBoxConfig(store.runtimeSnapshot(remote.host.id)).inbounds[0].users.find(entry => entry.uuid === store.clientCredential(user.id).runtimeUuid).name, user.email);
});

test("deleting a User leaves its legacy alias reserved when the email is reused across restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-identity-deletion-"));
  const options = { dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "identity-deletion-password", seedDemoData: false };
  let store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const create = () => store.createUser({ name: "Reused Email", email: "deleted@example.test", quotaGb: 10, nodeScope: ["all"], portalStatus: "active", expiresAt: "2099-12-31" });
  let sequence = 0;
  const sample = (name, bytes) => store.recordUsageSnapshot("local", {
    sampleId: `deleted-user-sample-${++sequence}`, runtimeInstanceId: "deleted-user-runtime",
    users: [{ name, uplinkBytes: bytes, downlinkBytes: 0 }]
  });
  const original = create();
  assert.equal(sample(original.email, 100).appliedBytes, 100);
  store.close();
  // The current management surface does not delete Users. Prepare a genuine
  // deleted-account database through the schema's foreign-key delete action.
  const deleted = new DatabaseSync(options.dbPath);
  deleted.exec("PRAGMA foreign_keys=ON");
  deleted.prepare("DELETE FROM users WHERE id=?").run(original.id);
  deleted.close();
  store = new RayLinkStore(options);
  assert.equal(store.getUser(original.id), null);
  const replacement = create();
  const runtimeName = store.clientCredential(replacement.id).runtimeName;
  assert.notEqual(runtimeName, original.email);
  assert.equal(sample(original.email, 150).appliedBytes, 0);
  assert.equal(store.getUser(replacement.id).usedGb, 0);
  assert.equal(sample(runtimeName, 250).appliedBytes, 250);
  store.close();
  store = new RayLinkStore(options);
  assert.equal(store.clientCredential(replacement.id).runtimeName, runtimeName);
  assert.equal(sample(original.email, 200).appliedBytes, 0);
  assert.equal(sample(runtimeName, 300).appliedBytes, 50);
  assert.equal(store.getUser(replacement.id).usedGb * 1024 ** 3, 300);
});

test("legacy migration quarantines an email shared by conflicting historical credentials and persists stable replacements", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-identity-conflict-"));
  const options = { dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "identity-conflict-password", seedDemoData: false };
  let store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const reusedEmail = "conflicting@example.test";
  const create = () => store.createUser({ name: "Historical Owner", email: reusedEmail, quotaGb: 10, nodeScope: ["all"], portalStatus: "active", expiresAt: "2099-12-31" });
  store.updateHostProtocolConfig("local", "vmess", { enabled: true });
  const retainLegacyDeployment = version => {
    const config = buildSingBoxConfig(store.runtimeSnapshot());
    for (const inbound of config.inbounds) for (const user of inbound.users || []) {
      if (user.name !== "raylink-probe@internal") user.name = reusedEmail;
    }
    const id = store.createDeployment({ version, configJson: config, checksum: version, eligibleUsers: 1 });
    store.finishDeployment(id, { status: "active" });
  };
  const original = create();
  const originalCredential = store.clientCredential(original.id);
  retainLegacyDeployment("legacy-identity-owner-a");
  store.updateUser(original.id, { email: "original-owner@example.test", state: "disabled" });
  const replacement = create();
  const replacementCredential = store.clientCredential(replacement.id);
  assert.notEqual(originalCredential.runtimeUuid, replacementCredential.runtimeUuid);
  assert.notEqual(originalCredential.runtimePassword, replacementCredential.runtimePassword);
  retainLegacyDeployment("legacy-identity-owner-b");
  store.updateUser(original.id, { state: "active" });
  store.close();
  // Upgrade input retains both historical UUID/password configurations, but
  // has none of the new alias ownership or authorization migration state.
  const legacy = new DatabaseSync(options.dbPath);
  legacy.exec("UPDATE users SET runtime_name=NULL; DELETE FROM runtime_identity_aliases; DELETE FROM host_usage_authorizations; DELETE FROM usage_runtime_identity_bindings; DELETE FROM settings WHERE key='runtime_identity_history_migrated'");
  legacy.close();
  store = new RayLinkStore(options);
  let sequence = 0;
  const sample = (name, bytes) => store.recordUsageSnapshot("local", {
    sampleId: `conflicting-alias-sample-${++sequence}`, runtimeInstanceId: "conflicting-legacy-runtime",
    users: [{ name, uplinkBytes: bytes, downlinkBytes: 0 }]
  });
  const stableName = store.clientCredential(replacement.id).runtimeName;
  assert.equal(stableName, `rl-user-${replacement.id}`);
  assert.notEqual(stableName, reusedEmail);
  const compiled = buildSingBoxConfig(store.runtimeSnapshot());
  const vmessUsers = compiled.inbounds.find(inbound => inbound.type === "vmess").users;
  assert.ok(vmessUsers.some(user => user.uuid === replacementCredential.runtimeUuid && user.name === stableName));
  assert.ok(!vmessUsers.some(user => user.name === reusedEmail));
  assert.equal(sample(reusedEmail, 1_000).appliedBytes, 0, "ambiguous old counters must not be attributed to either owner");
  assert.equal(store.getUser(original.id).usedGb, 0);
  assert.equal(store.getUser(replacement.id).usedGb, 0);
  assert.equal(sample(stableName, 250).appliedBytes, 250);
  store.close();
  store = new RayLinkStore(options);
  assert.equal(store.clientCredential(replacement.id).runtimeName, stableName);
  assert.equal(sample(reusedEmail, 1_300).appliedBytes, 0);
  assert.equal(sample(stableName, 300).appliedBytes, 50);
  assert.equal(store.getUser(original.id).usedGb, 0);
  assert.equal(store.getUser(replacement.id).usedGb * 1024 ** 3, 300);
});
