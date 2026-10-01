import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";

test("failed older deployment cannot retry after its replacement succeeds", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-task-order-"));
  const store = new RayLinkStore({ dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "test-password-123", seedDemoData: false, nodeTaskRetryBaseMs: 0 });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const { host, enrollmentToken } = store.createRemoteHost({ name: "Task Host", address: "192.0.2.1", region: "hk" });
  store.enrollNode(enrollmentToken);
  store.queueNodeTask(host.id, "publish-config", { version: "old", configText: '{"version":"old"}' });
  const oldTask = store.nextNodeTask(host.id);
  store.queueNodeTask(host.id, "publish-config", { version: "new", configText: '{"version":"new"}' });
  store.completeNodeTask(host.id, oldTask.id, { status: "failed", attempt: oldTask.attempt, error: "temporary failure" });
  const replacement = store.nextNodeTask(host.id);
  assert.equal(replacement.payload.version, "new");
  store.completeNodeTask(host.id, replacement.id, { status: "succeeded", attempt: replacement.attempt });
  assert.equal(store.nextNodeTask(host.id), null, "older failed config must not resurrect after the new config was applied");
  assert.deepEqual(store.latestAppliedNodeConfig(host.id), { version: "new" });
});

test("expired lease of an unreported older task cannot replay after its replacement succeeds", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-task-lease-"));
  const store = new RayLinkStore({ dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "test-password-123", seedDemoData: false });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { host, enrollmentToken } = store.createRemoteHost({ name: "Task Host", address: "192.0.2.1", region: "hk" });
  store.enrollNode(enrollmentToken);
  store.queueNodeTask(host.id, "publish-config", { version: "old", configText: '{"version":"old"}' });
  const oldTask = store.nextNodeTask(host.id);
  store.queueNodeTask(host.id, "publish-config", { version: "new", configText: '{"version":"new"}' });
  const replacement = store.nextNodeTask(host.id);
  assert.equal(replacement.payload.version, "new");
  store.completeNodeTask(host.id, replacement.id, { status: "succeeded", attempt: replacement.attempt });
  t.mock.timers.tick(61_000);
  assert.equal(store.nextNodeTask(host.id), null);
  assert.equal(store.completeNodeTask(host.id, oldTask.id, { status: "succeeded", attempt: oldTask.attempt }).ignored, true);
  assert.deepEqual(store.latestAppliedNodeConfig(host.id), { version: "new" });
});
