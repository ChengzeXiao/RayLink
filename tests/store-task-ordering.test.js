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

for (const claimed of [false, true]) test(`replacement inherits unlimited monthly retry from a ${claimed ? "claimed" : "pending"} normal task`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-monthly-retry-"));
  const store = new RayLinkStore({ dbPath: join(directory, "store.db"), adminUsername: "admin",
    adminPassword: "monthly-task-test", seedDemoData: false, nodeTaskRetryBaseMs: 0 });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const { host, enrollmentToken } = store.createRemoteHost({ name: "Task Host", address: "192.0.2.1", region: "hk" });
  store.enrollNode(enrollmentToken);
  store.queueNodeTask(host.id, "publish-config", { version: "monthly", configText: "{}" }, { maxAttempts: 0 });
  const old = claimed ? store.nextNodeTask(host.id) : null;
  const replacement = store.queueNodeTask(host.id, "publish-config", { version: "latest", configText: '{"version":"latest"}' });
  for (let attempt = 1; attempt <= 7; attempt++) {
    const task = store.nextNodeTask(host.id);
    assert.equal(task?.id, replacement);
    assert.equal(task.priority, "normal");
    assert.equal(store.completeNodeTask(host.id, task.id, { status: "failed", attempt: task.attempt, error: "offline" }).status, "pending");
  }
  const final = store.nextNodeTask(host.id);
  store.completeNodeTask(host.id, final.id, { status: "succeeded", attempt: final.attempt });
  assert.equal(store.nextNodeTask(host.id), null);
  if (old) assert.equal(store.completeNodeTask(host.id, old.id, { status: "succeeded", attempt: old.attempt }).ignored, true);
  assert.equal(store.latestAppliedNodeConfig(host.id).version, "latest");
});

test("ordinary publication without a predecessor retains the finite retry limit", async t => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-finite-retry-"));
  const store = new RayLinkStore({ dbPath: join(directory, "store.db"), adminUsername: "admin",
    adminPassword: "monthly-task-test", seedDemoData: false, nodeTaskRetryBaseMs: 0 });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const { host, enrollmentToken } = store.createRemoteHost({ name: "Task Host", address: "192.0.2.1", region: "hk" });
  store.enrollNode(enrollmentToken);
  store.queueNodeTask(host.id, "publish-config", { version: "ordinary", configText: "{}" });
  for (let attempt = 1; attempt <= 5; attempt++) {
    const task = store.nextNodeTask(host.id);
    assert.ok(task);
    assert.equal(store.completeNodeTask(host.id, task.id, { status: "failed", attempt: task.attempt }).status, attempt < 5 ? "pending" : "failed");
  }
  assert.equal(store.nextNodeTask(host.id), null);
});
