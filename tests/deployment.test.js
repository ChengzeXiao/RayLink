import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

import { RayLinkStore } from "../server/database.js";
import { RuntimeManager } from "../server/singbox/runtime-manager.js";

class RecordingRuntimeAdapter {
  constructor() {
    this.publications = [];
  }

  async publish(publication) {
    this.publications.push(publication);
    return { mode: "test", runtimeVersion: "sing-box-test" };
  }

  async status() {
    return { state: "running", mode: "test", runtimeVersion: "sing-box-test" };
  }
}

test("deployment publishes a validated snapshot without exposing credentials in its result", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-deploy-"));
  const store = new RayLinkStore({
    dbPath: join(dataDir, "raylink.db"),
    adminUsername: "admin",
    adminPassword: "Admin@2026"
  });
  const adapter = new RecordingRuntimeAdapter();
  const manager = new RuntimeManager({ store, adapter, listenPort: 8388 });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const preview = manager.preview();
  assert.equal(preview.eligibleUsers, 5);
  assert.match(preview.checksum, /^[a-f0-9]{64}$/);
  assert.equal("configText" in preview, false);

  const deployment = await manager.publish();
  assert.equal(deployment.status, "active");
  assert.equal(deployment.eligibleUsers, 5);
  assert.equal("configJson" in deployment, false);
  assert.equal(adapter.publications.length, 1);

  const publishedConfig = JSON.parse(adapter.publications[0].configText);
  assert.equal(publishedConfig.inbounds[0].users.length, 6);
  assert.ok(publishedConfig.inbounds[0].users.every((user) => user.password));
  assert.equal(
    publishedConfig.inbounds[0].users.at(-1).name,
    "raylink-probe@internal"
  );
  assert.equal(store.listDeployments()[0].status, "active");
});

test("deployment failure is recorded and leaves the previous runtime untouched", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-deploy-fail-"));
  const store = new RayLinkStore({
    dbPath: join(dataDir, "raylink.db"),
    adminUsername: "admin",
    adminPassword: "Admin@2026"
  });
  let failure = new Error("sing-box check failed");
  const adapter = {
    async publish() {
      throw failure;
    },
    async status() {
      return { state: "unknown", mode: "test" };
    }
  };
  const manager = new RuntimeManager({ store, adapter, listenPort: 8388 });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  await assert.rejects(() => manager.publish(), /sing-box check failed/);
  assert.equal(store.listDeployments()[0].status, "failed");
  failure = Object.assign(new Error("candidate restart failed"), {
    rolledBack: false, rollbackError: "previous service is unavailable"
  });
  await assert.rejects(() => manager.publish(), /candidate restart failed/);
  const failed = store.listDeployments().find((deployment) => deployment.error?.includes("candidate restart failed"));
  assert.match(failed.error, /previous service is unavailable/);
});

test("runtime manager rejects a concurrent publication", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-deploy-concurrent-"));
  const store = new RayLinkStore({
    dbPath: join(dataDir, "raylink.db"),
    adminUsername: "admin",
    adminPassword: "Admin@2026"
  });
  let releasePublish;
  const gate = new Promise((resolve) => {
    releasePublish = resolve;
  });
  const adapter = {
    async publish() {
      await gate;
      return { mode: "test", runtimeVersion: "1.13.12" };
    },
    async status() {
      return { state: "running", mode: "test" };
    }
  };
  const manager = new RuntimeManager({ store, adapter, listenPort: 8388 });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const first = manager.publish();
  store.updateHostProtocolConfig("local", "vless", {
    enabled: true,
    listen: "::",
    port: 8443,
    tls: { mode: "none" },
    transport: { type: "none" },
    options: {}
  });
  await assert.rejects(
    () => manager.publish(),
    (error) => error.code === "DEPLOYMENT_IN_PROGRESS" && error.statusCode === 409
  );
  releasePublish();
  assert.equal((await first).status, "active");
  assert.equal(
    store.getHost("local").appliedProtocols.find((profile) => profile.type === "vless").enabled,
    false
  );
  assert.equal(store.listDeployments().length, 1);
});

test("runtime manager reserves publication before asynchronous TLS preparation", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-deploy-preparation-"));
  const store = new RayLinkStore({
    dbPath: join(dataDir, "raylink.db"), adminUsername: "admin", adminPassword: "test-password"
  });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const host = store.createRemoteHost({ name: "Remote", address: "remote.example.com", region: "test" });
  store.enrollNode(host.enrollmentToken, {
    hostname: "remote", platform: "linux", architecture: "amd64",
    agentVersion: "0.8.0", runtimeVersion: "1.14.2"
  });
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const preparing = new Promise((resolve) => { started = resolve; });
  let preparations = 0;
  const adapter = new RecordingRuntimeAdapter();
  const manager = new RuntimeManager({ store, adapter, tlsAssetPackager: {
    async prepare(config) {
      if (++preparations === 1) { started(); await gate; }
      return { config, tlsAssets: [] };
    }
  } });
  const first = manager.publish();
  await preparing;
  let conflict;
  try { await manager.publish(); } catch (error) { conflict = error; }
  release();
  await first;
  assert.equal(conflict?.code, "DEPLOYMENT_IN_PROGRESS");
  assert.equal(adapter.publications.length, 1);
  assert.equal(store.listDeployments().length, 1);
});

test("rollback republishes an immutable historical snapshot as a new active deployment", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-deploy-rollback-"));
  const store = new RayLinkStore({
    dbPath: join(dataDir, "raylink.db"),
    adminUsername: "admin",
    adminPassword: "Admin@2026"
  });
  const adapter = new RecordingRuntimeAdapter();
  const manager = new RuntimeManager({ store, adapter, listenPort: 8388 });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const first = await manager.publish();
  const firstConfig = adapter.publications[0].configText;
  store.updateHostProtocolConfig("local", "vless", {
    enabled: true,
    listen: "::",
    port: 8443,
    tls: { mode: "none" },
    transport: { type: "none" },
    options: {}
  });
  const user = store.listUsers().find((candidate) => candidate.email === "priya@vantage-bioworks.in");
  store.updateUser(user.id, { usedGb: 320 });
  const second = await manager.publish();

  assert.equal(store.listDeployments().find((deployment) => deployment.id === first.id).status, "superseded");
  assert.equal(second.eligibleUsers, 4);
  assert.equal(
    store.getHost("local").appliedProtocols.find((profile) => profile.type === "vless").enabled,
    true
  );

  const rollback = await manager.rollback(first.id);
  assert.match(rollback.version, /^r/);
  assert.equal(rollback.status, "active");
  assert.equal(rollback.eligibleUsers, 5);
  assert.equal(adapter.publications.length, 3);
  assert.equal(adapter.publications[2].configText, firstConfig);
  assert.equal(
    store.getHost("local").appliedProtocols.find((profile) => profile.type === "vless").enabled,
    false
  );
  assert.equal(
    store.listDeployments().find((deployment) => deployment.id === second.id).status,
    "superseded"
  );
});

test("rollback queues the matching historical protocol snapshot for remote Hosts", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-deploy-remote-rollback-"));
  const store = new RayLinkStore({
    dbPath: join(dataDir, "raylink.db"),
    adminUsername: "admin",
    adminPassword: "Admin@2026"
  });
  const created = store.createRemoteHost({
    name: "Singapore",
    address: "sg.example.com",
    region: "singapore"
  });
  const enrolled = store.enrollNode(created.enrollmentToken, {
    hostname: "sg-01",
    platform: "linux",
    architecture: "amd64",
    agentVersion: "0.7.0",
    runtimeVersion: "1.13.12"
  });
  const adapter = new RecordingRuntimeAdapter();
  const manager = new RuntimeManager({
    store,
    adapter,
    listenPort: 8388,
    tlsAssetPackager: {
      async prepare(config) {
        return {
          config,
          sealedTlsBundle: "sealed-test-bundle",
          tlsAssets: [{
            name: "raylink-trojan",
            fingerprint256: "AA:BB",
            validTo: "2026-08-05T12:00:00.000Z"
          }]
        };
      }
    }
  });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  store.updateHostProtocolConfig(enrolled.hostId, "shadowsocks", { enabled: true });
  const first = await manager.publish();
  assert.equal(first.rolloutStatus, "pending");
  assert.deepEqual(
    first.targets.map((target) => [target.hostId, target.status]),
    [["local", "applied"], [enrolled.hostId, "pending"]]
  );
  assert.deepEqual(
    first.targets.find((target) => target.hostId === enrolled.hostId).certificates,
    [{
      name: "raylink-trojan",
      fingerprint256: "AA:BB",
      validTo: "2026-08-05T12:00:00.000Z"
    }]
  );
  const firstTask = store.nextNodeTask(enrolled.hostId);
  assert.equal(
    store.listDeployments().find((deployment) => deployment.id === first.id)
      .targets.find((target) => target.hostId === enrolled.hostId).status,
    "deploying"
  );
  store.completeNodeTask(enrolled.hostId, firstTask.id, {
    attempt: firstTask.attempt,
    status: "succeeded",
    runtimeVersion: "1.13.12"
  });
  const appliedFirst = store.listDeployments().find((deployment) => deployment.id === first.id);
  assert.equal(appliedFirst.rolloutStatus, "complete");
  assert.equal(
    appliedFirst.targets.find((target) => target.hostId === enrolled.hostId).status,
    "applied"
  );

  store.updateHostProtocolConfig(enrolled.hostId, "vless", {
    enabled: true,
    listen: "::",
    port: 8443,
    tls: { mode: "none" },
    transport: { type: "none" },
    options: {}
  });
  await manager.publish();
  const secondTask = store.nextNodeTask(enrolled.hostId);
  store.completeNodeTask(enrolled.hostId, secondTask.id, {
    attempt: secondTask.attempt,
    status: "succeeded",
    runtimeVersion: "1.13.12"
  });

  const rollback = await manager.rollback(first.id);
  assert.equal(rollback.remoteQueued, 1);
  const rollbackTask = store.nextNodeTask(enrolled.hostId);
  assert.equal(rollbackTask.priority, "normal");
  assert.deepEqual(
    rollbackTask.payload.protocols
      .filter((profile) => profile.enabled)
      .map((profile) => profile.type),
    ["shadowsocks"]
  );
  assert.deepEqual(
    JSON.parse(rollbackTask.payload.configText).inbounds.map((inbound) => inbound.type),
    ["shadowsocks"]
  );
});

test("concurrent control-plane processes cannot claim the same RayLink Node task", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-task-claim-"));
  const dbPath = join(dataDir, "raylink.db");
  const store = new RayLinkStore({
    dbPath,
    adminUsername: "admin",
    adminPassword: "Admin@2026",
    seedDemoData: false
  });
  const created = store.createRemoteHost({
    name: "Concurrent claim Host",
    address: "claim.example.com",
    region: "singapore"
  });
  const enrolled = store.enrollNode(created.enrollmentToken, {
    hostname: "claim-01",
    platform: "linux",
    architecture: "amd64",
    agentVersion: "0.7.0",
    runtimeVersion: "1.13.14"
  });
  const taskId = store.queueNodeTask(enrolled.hostId, "publish-config", {
    version: "concurrent-claim",
    checksum: "sha256:claim",
    configText: "{}"
  });
  store.close();
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const moduleUrl = pathToFileURL(join(process.cwd(), "server/database.js")).href;
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      let store;
      try {
        const { RayLinkStore } = await import(workerData.moduleUrl);
        store = new RayLinkStore({
          dbPath: workerData.dbPath,
          adminUsername: "admin",
          adminPassword: "Admin@2026",
          seedDemoData: false
        });
        parentPort.postMessage({ type: "ready" });
        Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
        parentPort.postMessage({ type: "result", task: store.nextNodeTask(workerData.hostId) });
      } catch (error) {
        parentPort.postMessage({ type: "error", error: error.message });
      } finally {
        store?.close();
      }
    })();
  `;
  const claims = Array.from({ length: 2 }, () => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { barrier, dbPath, hostId: enrolled.hostId, moduleUrl }
    });
    let markReady;
    let finish;
    const ready = new Promise((resolve) => {
      markReady = resolve;
    });
    const result = new Promise((resolve, reject) => {
      finish = { resolve, reject };
    });
    worker.on("message", (message) => {
      if (message.type === "ready") markReady();
      if (message.type === "result") finish.resolve(message.task);
      if (message.type === "error") finish.reject(new Error(message.error));
    });
    worker.on("error", finish.reject);
    return { worker, ready, result };
  });

  await Promise.all(claims.map((claim) => claim.ready));
  Atomics.store(new Int32Array(barrier), 0, 1);
  Atomics.notify(new Int32Array(barrier), 0);
  const results = await Promise.all(claims.map((claim) => claim.result));
  await Promise.all(claims.map((claim) => claim.worker.terminate()));

  assert.equal(results.filter((task) => task?.id === taskId).length, 1);
  assert.equal(results.filter((task) => task === null).length, 1);
});

test("store waits for a concurrent SQLite bootstrap lock before enabling WAL", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-store-bootstrap-lock-"));
  const dbPath = join(dataDir, "raylink.db");
  const blocker = new DatabaseSync(dbPath);
  blocker.exec("PRAGMA journal_mode=DELETE; CREATE TABLE bootstrap_lock (id INTEGER); BEGIN EXCLUSIVE;");
  let transactionOpen = true;
  let worker;

  t.after(async () => {
    if (transactionOpen) blocker.exec("ROLLBACK");
    blocker.close();
    await worker?.terminate();
    await rm(dataDir, { recursive: true, force: true });
  });

  const moduleUrl = pathToFileURL(join(process.cwd(), "server/database.js")).href;
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      parentPort.postMessage({ type: "started" });
      let store;
      try {
        const { RayLinkStore } = await import(workerData.moduleUrl);
        store = new RayLinkStore({
          dbPath: workerData.dbPath,
          adminUsername: "admin",
          adminPassword: "Admin@2026",
          seedDemoData: false
        });
        parentPort.postMessage({ type: "ready" });
      } catch (error) {
        parentPort.postMessage({ type: "error", error: error.message });
      } finally {
        store?.close();
      }
    })();
  `;
  worker = new Worker(workerSource, {
    eval: true,
    workerData: { dbPath, moduleUrl }
  });
  const messages = [];
  let resolveMessage;
  const nextMessage = () => new Promise((resolve) => {
    const queued = messages.shift();
    if (queued) {
      resolve(queued);
      return;
    }
    resolveMessage = resolve;
  });
  worker.on("message", (message) => {
    if (resolveMessage) {
      const resolve = resolveMessage;
      resolveMessage = undefined;
      resolve(message);
      return;
    }
    messages.push(message);
  });

  assert.equal((await nextMessage()).type, "started");
  await new Promise((resolve) => setTimeout(resolve, 100));
  blocker.exec("COMMIT");
  transactionOpen = false;
  const result = await nextMessage();
  assert.deepEqual(result, { type: "ready" });
});

test("publication migrates ACME only after the Host reports a 1.14 Runtime", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-acme-migration-"));
  const store = new RayLinkStore({ dbPath: join(dataDir, "raylink.db"),
    adminUsername: "admin", adminPassword: "test-upgrade-password" });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const adapter = new RecordingRuntimeAdapter();
  const manager = new RuntimeManager({ store, adapter, listenPort: 8388 });
  store.updateHostProtocolConfig("local", "hysteria2", {
    enabled: true, port: 8448,
    tls: { mode: "acme", serverName: "node.example.com", acmeEmail: "ops@example.com" }
  });
  for (const version of ["1.13.14", "1.14.2"]) {
    store.updateLocalRuntimeCapabilities({ version, platform: "linux", tags: ["with_acme", "with_quic"] });
    await manager.publish();
    const tls = JSON.parse(adapter.publications.at(-1).configText).inbounds
      .find((inbound) => inbound.type === "hysteria2").tls;
    assert.equal(Boolean(tls.certificate_provider), version === "1.14.2");
    assert.equal(Boolean(tls.acme), version === "1.13.14");
  }
});

async function monthlyDeploymentFixture(t, nodeTaskRetryBaseMs = 0) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-monthly-deploy-"));
  const store = new RayLinkStore({ dbPath: join(dataDir, "store.db"), adminUsername: "admin",
    adminPassword: "monthly-deployment-test", seedDemoData: false, nodeTaskRetryBaseMs });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const { host, enrollmentToken } = store.createRemoteHost({ name: "Monthly Host", address: "192.0.2.5", region: "hk" });
  store.enrollNode(enrollmentToken, { agentVersion: "0.9.0", runtimeVersion: "1.14.2" });
  store.updateHostProtocolConfig(host.id, "shadowsocks", { enabled: true });
  const manager = new RuntimeManager({ store, adapter: new RecordingRuntimeAdapter() });
  return { store, host, manager };
}

test("current monthly publication remains pending until the remote receipt and survives more than five failures", async t => {
  const { store, host, manager } = await monthlyDeploymentFixture(t);
  await manager.publish();
  const initial = await manager.reconcile(null, { retryUntilApplied: true });
  assert.equal(initial.changed, false);
  assert.equal(initial.remotePending, 1);
  assert.equal(initial.remoteQueued, 0);
  let id;
  for (let attempt = 1; attempt <= 7; attempt++) {
    const task = store.nextNodeTask(host.id);
    id ||= task.id;
    assert.equal(task.id, id);
    assert.equal(task.attempt, attempt);
    const claimed = await manager.reconcile(null, { retryUntilApplied: true });
    assert.equal(claimed.remotePending, 1);
    assert.equal(claimed.remoteQueued, 0);
    assert.equal(store.completeNodeTask(host.id, task.id, { status: "failed", attempt: task.attempt }).status, "pending");
  }
  const final = store.nextNodeTask(host.id);
  store.completeNodeTask(host.id, final.id, { status: "succeeded", attempt: final.attempt });
  assert.equal((await manager.reconcile(null, { retryUntilApplied: true })).remotePending, 0);
  assert.equal(store.nextNodeTask(host.id), null);
  assert.equal(store.listDeployments().length, 1, "retrying a remote must not republish the local Runtime");
});

test("a terminally failed remote task is recovered without republishing the current local configuration", async t => {
  const { store, host, manager } = await monthlyDeploymentFixture(t);
  const deployment = await manager.publish();
  let oldId;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const task = store.nextNodeTask(host.id);
    oldId = task.id;
    store.completeNodeTask(host.id, task.id, { status: "failed", attempt: task.attempt });
  }
  assert.equal(store.nextNodeTask(host.id), null);
  const recovered = await manager.reconcile(null, { retryUntilApplied: true });
  assert.equal(recovered.changed, false);
  assert.equal(recovered.remotePending, 1);
  assert.equal(recovered.remoteQueued, 1);
  const replacement = store.nextNodeTask(host.id);
  assert.notEqual(replacement.id, oldId);
  assert.equal(replacement.payload.version, deployment.version);
  store.completeNodeTask(host.id, replacement.id, { status: "succeeded", attempt: replacement.attempt });
  const current = await manager.reconcile(null, { retryUntilApplied: true });
  assert.equal(current.remotePending, 0);
  assert.equal(current.remoteQueued, 0);
  assert.equal(store.listDeployments().length, 1);
});

test("monthly synchronization preserves matching task leases and scheduled retry backoff", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { store, host, manager } = await monthlyDeploymentFixture(t, 30_000);
  await manager.publish();
  const initial = store.nextNodeTask(host.id);
  store.completeNodeTask(host.id, initial.id, { status: "failed", attempt: initial.attempt });
  for (let poll = 0; poll < 3; poll++) {
    const waiting = await manager.reconcile(null, { retryUntilApplied: true });
    assert.equal(waiting.remoteQueued, 0);
    assert.equal(waiting.remotePending, 1);
    assert.equal(store.nextNodeTask(host.id), null);
  }
  t.mock.timers.tick(29_999);
  assert.equal(store.nextNodeTask(host.id), null);
  t.mock.timers.tick(1);
  const retried = store.nextNodeTask(host.id);
  assert.equal(retried.id, initial.id);
  assert.equal(retried.attempt, 2);
  assert.equal((await manager.reconcile(null, { retryUntilApplied: true })).remoteQueued, 0);
  assert.equal(store.nextNodeTask(host.id), null, "an in-flight matching task keeps its lease");
  store.completeNodeTask(host.id, retried.id, { status: "succeeded", attempt: retried.attempt });
  assert.equal((await manager.reconcile(null, { retryUntilApplied: true })).remotePending, 0);
});

test("a monthly entitlement change waits for the new remote config and ignores unenrolled Hosts", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { store, host, manager } = await monthlyDeploymentFixture(t);
  store.createRemoteHost({ name: "Not yet enrolled", address: "192.0.2.6", region: "hk" });
  await manager.publish();
  const before = store.nextNodeTask(host.id);
  store.completeNodeTask(host.id, before.id, { status: "succeeded", attempt: before.attempt });
  assert.equal((await manager.reconcile(null, { retryUntilApplied: true })).remotePending, 0);
  const user = store.createUser({ name: "Restored User", email: "monthly-restored@example.test", quotaGb: 10,
    nodeScope: ["all"], portalStatus: "active", expiresAt: "2099-12-31" });
  const changed = await manager.reconcile(null, { retryUntilApplied: true });
  assert.equal(changed.changed, true);
  assert.equal(changed.remotePending, 1);
  assert.equal(changed.remoteQueued, 1);
  const task = store.nextNodeTask(host.id);
  assert.ok(JSON.parse(task.payload.configText).inbounds.some(inbound => inbound.users?.some(entry => entry.name === user.email)));
  store.completeNodeTask(host.id, task.id, { status: "succeeded", attempt: task.attempt });
  assert.equal((await manager.reconcile(null, { retryUntilApplied: true })).remotePending, 0);
  assert.equal(store.listDeployments().length, 2);
});
