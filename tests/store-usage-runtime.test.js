import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-runtime-ledger-"));
  const options = { dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "test-password-123", seedDemoData: false };
  const store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const user = store.createUser({ name: "Usage user", email: "usage@example.com", quotaGb: 10, nodeScope: ["all"], expiresAt: "2027-01-01" });
  return { store, user, options };
}

test("interleaved delivery across Runtime restarts charges each cumulative counter only once", async (t) => {
  const { store, user } = await fixture(t);
  const sample = (id, runtime, bytes) => store.recordUsageSnapshot("local", {
    sampleId: id, runtimeInstanceId: runtime, users: [{ name: user.email, uplinkBytes: bytes, downlinkBytes: 0 }]
  });
  sample("sample-a1", "runtime-a", 100);
  sample("sample-b1", "runtime-b", 20);
  assert.equal(sample("sample-a2", "runtime-a", 120).appliedBytes, 20);
  assert.equal(sample("sample-b2", "runtime-b", 30).appliedBytes, 10);
  assert.equal(store.getUser(user.id).usedGb * 1024 ** 3, 150);
});

test("legacy checkpoint migration preserves metered bytes across reopen and keeps Hosts independent", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await mkdtemp(join(tmpdir(), "raylink-legacy-watermark-"));
  const options = { dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "test-password-123", seedDemoData: false };
  let store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const user = store.createUser({ name: "Usage user", email: "usage@example.com", quotaGb: 10, nodeScope: ["all"], expiresAt: "2027-01-01" });
  const sample = (host, id, bytes) => store.recordUsageSnapshot(host, { sampleId: id, runtimeInstanceId: "shared-instance", users: [{ name: user.email, uplinkBytes: bytes, downlinkBytes: 0 }] });
  sample("local", "sample-before", 100);
  store.close();
  // Set up the previously released schema as the migration input. All behavior
  // assertions below use the public store, never the database internals.
  const legacy = new DatabaseSync(options.dbPath);
  legacy.exec(`
    ALTER TABLE usage_counter_checkpoints RENAME TO checkpoints_fixture;
    CREATE TABLE usage_counter_checkpoints (
      host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL, runtime_instance_id TEXT NOT NULL,
      uplink_bytes INTEGER NOT NULL, downlink_bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(host_id, user_name)
    );
    INSERT INTO usage_counter_checkpoints SELECT host_id, user_name, runtime_instance_id, uplink_bytes, downlink_bytes, updated_at FROM checkpoints_fixture;
    DROP TABLE checkpoints_fixture;
  `);
  legacy.close();
  store = new RayLinkStore(options);
  assert.equal(sample("local", "sample-after", 130).appliedBytes, 30);
  const { host } = store.createRemoteHost({ name: "Other Host", address: "192.0.2.1", region: "hk" });
  assert.equal(sample(host.id, "sample-after", 50).appliedBytes, 50);
  store.close();
  store = new RayLinkStore(options);
  assert.equal(sample("local", "sample-reopen", 140).appliedBytes, 10);
  assert.equal(sample(host.id, "sample-reopen", 70).appliedBytes, 20);
  assert.equal(store.getUser(user.id).usedGb * 1024 ** 3, 210);
});

for (const retainLedger of [true, false]) test(`legacy migration ${retainLedger ? "recovers overwritten Runtime watermarks from the retained ledger" : "baselines unverifiable delayed counters without charging them twice"}`, async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await mkdtemp(join(tmpdir(), "raylink-legacy-epochs-"));
  const options = { dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "test-password-123", seedDemoData: false };
  let store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const user = store.createUser({ name: "Usage user", email: "usage@example.com", quotaGb: 10, nodeScope: ["all"], expiresAt: "2027-01-01" });
  const sample = (id, runtime, bytes) => store.recordUsageSnapshot("local", { sampleId: id, runtimeInstanceId: runtime, users: [{ name: user.email, uplinkBytes: bytes, downlinkBytes: 0 }] });
  sample("sample-old-a", "runtime-a", 100);
  sample("sample-old-b", "runtime-b", 20);
  store.close();
  const legacy = new DatabaseSync(options.dbPath);
  legacy.exec(`
    ALTER TABLE usage_counter_checkpoints RENAME TO checkpoints_fixture;
    CREATE TABLE usage_counter_checkpoints (
      host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL, runtime_instance_id TEXT NOT NULL,
      uplink_bytes INTEGER NOT NULL, downlink_bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(host_id, user_name)
    );
    INSERT INTO usage_counter_checkpoints SELECT host_id, user_name, runtime_instance_id, uplink_bytes, downlink_bytes, updated_at FROM checkpoints_fixture WHERE runtime_instance_id = 'runtime-b';
    DROP TABLE checkpoints_fixture;
  `);
  if (!retainLedger) {
    legacy.exec("PRAGMA foreign_keys=ON; DELETE FROM usage_samples WHERE runtime_instance_id = 'runtime-a'");
  }
  legacy.close();
  const beforeUpgrade = new Date(Date.now() - 1_000).toISOString();
  store = new RayLinkStore(options);
  assert.equal(store.recordUsageSnapshot("local", {
    sampleId: "sample-late-a", runtimeInstanceId: "runtime-a", observedAt: beforeUpgrade,
    users: [{ name: user.email, uplinkBytes: 120, downlinkBytes: 0 }]
  }).appliedBytes, retainLedger ? 20 : 0);
  assert.equal(sample("sample-new-b", "runtime-b", 30).appliedBytes, 10);
  assert.equal(sample("sample-new-c", "runtime-c", 50).appliedBytes, 50, "a genuinely new Runtime still contributes its full counter");
  assert.equal(sample("sample-next-a", "runtime-a", 130).appliedBytes, 10);
  assert.equal(store.getUser(user.id).usedGb * 1024 ** 3, retainLedger ? 210 : 190);
});

test("migration never bills a partially retained ledger as a complete cumulative watermark", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await mkdtemp(join(tmpdir(), "raylink-pruned-epochs-"));
  // Keep this checkpoint-migration scenario inside one quota period.
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  let clock = now - 10 * 86_400_000;
  const options = { dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "test-password-123", seedDemoData: false, clock: () => new Date(clock) };
  let store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const user = store.createUser({ name: "Usage user", email: "usage@example.com", quotaGb: 10, nodeScope: ["all"], expiresAt: "2027-01-01" });
  const sample = (id, runtime, bytes) => store.recordUsageSnapshot("local", { sampleId: id, runtimeInstanceId: runtime, users: [{ name: user.email, uplinkBytes: bytes, downlinkBytes: 0 }] });
  sample("sample-first-a", "runtime-a", 100);
  clock = now - 86_400_000;
  sample("sample-later-a", "runtime-a", 120);
  sample("sample-first-b", "runtime-b", 10);
  clock = now;
  assert.equal(store.performOperationalMaintenance({ now: new Date(clock).toISOString(), usageDetailRetentionDays: 7 }).history.usageSamples, 1);
  store.close();
  const legacy = new DatabaseSync(options.dbPath);
  legacy.exec(`
    ALTER TABLE usage_counter_checkpoints RENAME TO checkpoints_fixture;
    CREATE TABLE usage_counter_checkpoints (
      host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
      user_name TEXT NOT NULL, runtime_instance_id TEXT NOT NULL,
      uplink_bytes INTEGER NOT NULL, downlink_bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(host_id, user_name)
    );
    INSERT INTO usage_counter_checkpoints SELECT host_id, user_name, runtime_instance_id, uplink_bytes, downlink_bytes, updated_at FROM checkpoints_fixture WHERE runtime_instance_id = 'runtime-b';
    DROP TABLE checkpoints_fixture;
  `);
  legacy.close();
  store = new RayLinkStore(options);
  clock += 60_000;
  assert.equal(sample("sample-delayed-a", "runtime-a", 130).appliedBytes, 0,
    "partial history cannot prove what was already charged, even for a post-migration observation");
  assert.equal(sample("sample-next-a", "runtime-a", 140).appliedBytes, 10);
  assert.equal(sample("sample-next-b", "runtime-b", 20).appliedBytes, 10);
  assert.equal(sample("sample-new-c", "runtime-c", 50).appliedBytes, 50);
  assert.equal(store.getUser(user.id).usedGb * 1024 ** 3, 200);
});
