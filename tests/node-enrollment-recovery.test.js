import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { RayLinkStore } from "../server/database.js";
import { generateNodeEncryptionKeypair, openNodeSecret } from "../server/node-secrets.js";
import { RayLinkNode } from "../web/node/raylink-node.mjs";

test("Node enrollment recovers a lost committed response after restart without exposing the credential to token replay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-enrollment-recovery-"));
  const store = new RayLinkStore({ dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "enrollment-test-password", seedDemoData: false });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const remote = store.createRemoteHost({ name: "Recovery Host", address: "192.0.2.17", region: "sg" });
  const statePath = join(directory, "node.json");
  let attempts = 0;
  const options = {
    serverUrl: "https://panel.example.test", enrollmentToken: remote.enrollmentToken,
    statePath, enableBbr: false, metadataProvider: async () => ({ hostname: "recovery-host" }),
    fetchFn: async (_url, init) => {
      const input = JSON.parse(init.body);
      const result = store.enrollNode(input.token, input);
      if (++attempts === 1) throw new Error("lost response after commit");
      assert.equal(result.nodeSecret, undefined, "retries only return an envelope encrypted to the original Node key");
      return new Response(JSON.stringify(result), { status: 201 });
    }
  };
  await assert.rejects(new RayLinkNode(options).ensureEnrolled(), /lost response/);
  const pending = JSON.parse(await readFile(statePath, "utf8"));
  assert.match(pending.encryptionPrivateKey, /BEGIN PRIVATE KEY/);
  const enrolled = await new RayLinkNode(options).ensureEnrolled();
  assert.equal(enrolled.hostId, remote.host.id);
  assert.ok(store.authenticateNode(enrolled.hostId, enrolled.nodeSecret));
  assert.equal(enrolled.encryptionPublicKey, pending.encryptionPublicKey);
  const otherKey = generateNodeEncryptionKeypair();
  assert.throws(() => store.enrollNode(remote.enrollmentToken, { encryptionPublicKey: otherKey.publicKey }), { code: "NODE_ENROLLMENT_INVALID" });
  const replay = store.enrollNode(remote.enrollmentToken, { encryptionPublicKey: pending.encryptionPublicKey });
  assert.equal(replay.nodeSecret, undefined);
  assert.throws(() => openNodeSecret(otherKey.privateKey, replay.sealedCredential));
  assert.equal(openNodeSecret(pending.encryptionPrivateKey, replay.sealedCredential).nodeSecret, enrolled.nodeSecret);
});

test("enrollment persists its key before contacting the control plane and recovers a failed credential write", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-enrollment-write-"));
  const store = new RayLinkStore({ dbPath: join(directory, "store.db"), adminUsername: "admin",
    adminPassword: "enrollment-write-password", seedDemoData: false });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const remote = store.createRemoteHost({ name: "Write Recovery Host", address: "192.0.2.19", region: "sg" });
  const statePath = join(directory, "node.json");
  let requests = 0;
  const options = { serverUrl: "https://panel.example.test", enrollmentToken: remote.enrollmentToken,
    statePath, enableBbr: false, metadataProvider: async () => ({}), fetchFn: async (_url, init) => {
      requests++;
      const input = JSON.parse(init.body);
      assert.equal(JSON.parse(await readFile(statePath, "utf8")).encryptionPublicKey, input.encryptionPublicKey);
      return new Response(JSON.stringify(store.enrollNode(input.token, input)), { status: 201 });
    } };
  const cannotSaveKey = new RayLinkNode(options);
  cannotSaveKey.persistState = async () => { throw new Error("key write failed"); };
  await assert.rejects(cannotSaveKey.ensureEnrolled(), /key write failed/);
  assert.equal(requests, 0, "an unpersisted recipient key cannot consume the enrollment token");

  const cannotSaveCredential = new RayLinkNode(options);
  const persist = cannotSaveCredential.persistState.bind(cannotSaveCredential);
  cannotSaveCredential.persistState = async state => {
    if (state.nodeSecret) throw new Error("credential write failed");
    return persist(state);
  };
  await assert.rejects(cannotSaveCredential.ensureEnrolled(), /credential write failed/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).enrollmentPending, true);
  const restarted = new RayLinkNode(options);
  const [first, second] = await Promise.all([restarted.ensureEnrolled(), restarted.ensureEnrolled()]);
  assert.equal(requests, 2, "concurrent recovery calls share one enrollment request");
  assert.equal(first.nodeSecret, second.nodeSecret);
  assert.ok(store.authenticateNode(first.hostId, first.nodeSecret));
});

test("two control-plane connections serialize enrollment and never let a different key take over", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-enrollment-race-"));
  const options = { dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "enrollment-race-password", seedDemoData: false };
  const store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const run = async (metadata) => {
    const remote = store.createRemoteHost({ name: "Race Host", address: "192.0.2.18", region: "us" });
    const workers = metadata.map(input => new Worker(`
      import { parentPort, workerData } from "node:worker_threads";
      const { RayLinkStore } = await import(workerData.moduleUrl);
      const store = new RayLinkStore(workerData.options);
      parentPort.once("message", () => {
        try { parentPort.postMessage({ ok: true, credential: store.enrollNode(workerData.token, workerData.metadata) }); }
        catch (error) { parentPort.postMessage({ ok: false, code: error.code }); }
        finally { store.close(); }
      });
      parentPort.postMessage({ ready: true });
    `, { eval: true, workerData: { moduleUrl: new URL("../server/database.js", import.meta.url).href, options, token: remote.enrollmentToken, metadata: input } }));
    t.after(() => Promise.all(workers.map(worker => worker.terminate())));
    await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
      worker.once("message", resolve); worker.once("error", reject);
    })));
    const results = workers.map(worker => new Promise((resolve, reject) => {
      worker.once("message", resolve); worker.once("error", reject);
    }));
    workers.forEach(worker => worker.postMessage("enroll"));
    return { remote, results: await Promise.all(results) };
  };
  const key = generateNodeEncryptionKeypair();
  const sameKey = await run([0, 1].map(() => ({ encryptionPublicKey: key.publicKey, sealedEnrollment: true })));
  assert.ok(sameKey.results.every(result => result.ok));
  const recovered = sameKey.results.map(result => openNodeSecret(key.privateKey, result.credential.sealedCredential));
  assert.equal(recovered[0].nodeSecret, recovered[1].nodeSecret);
  assert.ok(store.authenticateNode(sameKey.remote.host.id, recovered[0].nodeSecret));
  const otherKey = generateNodeEncryptionKeypair();
  const differentKeys = await run([key, otherKey].map(pair => ({ encryptionPublicKey: pair.publicKey, sealedEnrollment: true })));
  assert.equal(differentKeys.results.filter(result => result.ok).length, 1);
  assert.equal(differentKeys.results.find(result => !result.ok).code, "NODE_ENROLLMENT_INVALID");
  const legacy = await run([{}, {}]);
  assert.equal(legacy.results.filter(result => result.ok).length, 1);
  assert.equal(legacy.results.find(result => !result.ok).code, "NODE_ENROLLMENT_INVALID");
  assert.ok(store.authenticateNode(legacy.remote.host.id, legacy.results.find(result => result.ok).credential.nodeSecret));
});
