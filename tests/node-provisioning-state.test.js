import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";
import { ProvisioningState } from "../server/node-provisioning-state.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-provision-state-"));
  const options = { dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "test-password", seedDemoData: false };
  let store = new RayLinkStore(options);
  let state = new ProvisioningState(store);
  const adminId = store.listAdmins()[0].id;
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { adminId, options, get state() { return state; }, reopen() { store.close(); store = new RayLinkStore(options); state = new ProvisioningState(store); } };
}
const settings = { host: "203.0.113.10", port: 22, username: "root", name: "Tokyo", region: "tokyo", preset: "ip-stable" };

test("provisioning request identity survives reopening and never persists SSH credentials", async (t) => {
  const f = await fixture(t);
  const input = { ...settings, password: "PRIVATE_TEST_PASSWORD", privateKey: "PRIVATE_TEST_KEY", passphrase: "PRIVATE_TEST_PASSPHRASE", sudoPassword: "PRIVATE_TEST_SUDO", enrollmentToken: "PRIVATE_TEST_ENROLL" };
  const first = f.state.create({ adminId: f.adminId, requestId: "request-1", input });
  assert.equal(first.created, true);
  assert.equal(first.job.status, "queued");
  assert.deepEqual(first.job.input, settings);
  f.reopen();
  const retry = f.state.create({ adminId: f.adminId, requestId: "request-1", input: { ...settings, name: " Tokyo ", password: "REPLACED_PASSWORD" } });
  assert.equal(retry.created, false);
  assert.equal(retry.job.id, first.job.id);
  assert.equal(f.state.list().length, 1);
  assert.throws(() => f.state.create({ adminId: f.adminId, requestId: "request-1", input: { ...settings, region: "singapore" } }), (error) => error.code === "PROVISIONING_REQUEST_CONFLICT" && error.statusCode === 409);
  assert.doesNotMatch(JSON.stringify(f.state.list()), /PRIVATE_TEST|REPLACED_PASSWORD/);
  f.reopen();
  assert.doesNotMatch((await readFile(f.options.dbPath)).toString(), /PRIVATE_TEST|REPLACED_PASSWORD/);
});

test("a Host target has one active job globally and normalizes equivalent IPv6 spellings", async (t) => {
  const f = await fixture(t);
  const first = f.state.create({ adminId: f.adminId, requestId: "first", input: { host: "2001:0DB8:0:0::1", username: "root" } });
  assert.equal(first.job.input.host, "2001:db8::1");
  assert.equal(first.job.input.port, 22);
  assert.equal(first.job.input.preset, "ip-stable");
  assert.equal(first.job.input.region, "global");
  assert.equal(first.job.input.name, "VPS-2001:db8::1");
  f.reopen();
  assert.throws(() => f.state.create({ adminId: f.adminId, requestId: "second", input: { host: "[2001:db8::1]", username: "admin" } }), (error) => error.code === "PROVISIONING_TARGET_BUSY" && error.statusCode === 409 && error.jobId === first.job.id);
  const alternate = f.state.create({ adminId: f.adminId, requestId: "alternate-port", input: { host: "2001:db8::1", port: 2222, username: "root" } });
  assert.equal(alternate.created, true);
  for (const input of [{ ...settings, host: "host; touch /tmp/pwn" }, { ...settings, username: "root;id" }, { ...settings, port: 0 }, { ...settings, preset: "arbitrary-command" }]) {
    assert.throws(() => f.state.create({ adminId: f.adminId, requestId: "invalid", input }), (error) => error.code === "INVALID_PROVISIONING_INPUT");
  }
});

test("restarted attempts become interrupted and explicit retry preserves Host identity", async (t) => {
  const f = await fixture(t);
  const { job } = f.state.create({ adminId: f.adminId, requestId: "lifecycle", input: settings });
  f.state.update(job.id, { status: "running", stage: "installing", progress: 35, message: "安装 RayLink Node", hostId: "existing-host", password: "PRIVATE_PATCH", result: { password: "PRIVATE_RESULT" } });
  const pending = f.state.create({ adminId: f.adminId, requestId: "waiting", input: { ...settings, port: 2222 } }).job;
  f.reopen();
  assert.equal(f.state.interruptPending(), 2);
  assert.equal(f.state.interruptPending(), 0);
  assert.equal(f.state.get(job.id).status, "interrupted");
  assert.equal(f.state.get(pending.id).status, "interrupted");
  assert.equal(f.state.get(job.id).hostId, "existing-host");
  assert.ok(f.state.get(job.id).completedAt);
  assert.equal(f.state.create({ adminId: f.adminId, requestId: "lifecycle", input: settings }).created, false);
  const retried = f.state.retry(job.id);
  assert.equal(retried.status, "queued");
  assert.equal(retried.hostId, "existing-host");
  assert.equal(retried.completedAt, null);
  assert.throws(() => f.state.retry(job.id), (error) => error.code === "PROVISIONING_RETRY_NOT_ALLOWED");
  f.state.update(job.id, { status: "running", stage: "verifying", progress: 90, message: "验证节点" });
  const complete = f.state.update(job.id, { status: "succeeded", stage: "complete", progress: 100, message: "接入完成", result: { subscriptionStatus: "verified", eligibleUserCount: 2, verifiedUserCount: 2, protocolChecks: [{ type: "shadowsocks", state: "available", latencyMs: 45, password: "PRIVATE_CHECK" }], usageMeteringStatus: "healthy", enrollmentToken: "PRIVATE_ENROLL", config: { password: "PRIVATE_CONFIG" } } });
  assert.equal(complete.result.verifiedUserCount, 2);
  assert.deepEqual(complete.result.protocolChecks, [{ type: "shadowsocks", state: "available", latencyMs: 45 }]);
  assert.doesNotMatch(JSON.stringify(complete), /PRIVATE_/);
  assert.throws(() => f.state.update(job.id, { status: "running" }), (error) => error.code === "PROVISIONING_INVALID_TRANSITION");
  assert.throws(() => f.state.update(job.id, { hostId: "another-host" }), (error) => error.code === "PROVISIONING_HOST_CONFLICT");
  f.reopen();
  assert.deepEqual(f.state.get(job.id), complete);
  assert.doesNotMatch((await readFile(f.options.dbPath)).toString(), /PRIVATE_/);
});

test("SSH host-key pin survives restart and cannot be overwritten by another credential or retry", async (t) => {
  const f = await fixture(t);
  const fingerprint = `SHA256:${Buffer.alloc(32, 1).toString("base64").replace(/=+$/, "")}`;
  const different = `SHA256:${Buffer.alloc(32, 2).toString("base64").replace(/=+$/, "")}`;
  assert.equal(f.state.readFingerprint(settings.host, settings.port), null);
  assert.equal(f.state.pinFingerprint(settings.host, settings.port, fingerprint), fingerprint);
  f.reopen();
  assert.equal(f.state.readFingerprint(`::ffff:${settings.host}`, settings.port), fingerprint);
  assert.equal(f.state.pinFingerprint(settings.host, settings.port, fingerprint), fingerprint);
  assert.throws(() => f.state.pinFingerprint(settings.host, settings.port, different), (error) => error.code === "SSH_HOST_KEY_CHANGED" && error.statusCode === 409);
  assert.equal(f.state.readFingerprint(settings.host, settings.port), fingerprint);
  assert.equal(f.state.readFingerprint(settings.host, 2222), null);
  const { job } = f.state.create({ adminId: f.adminId, requestId: "pin", input: settings });
  assert.equal(f.state.update(job.id, { hostKeyFingerprint: fingerprint }).hostKeyFingerprint, fingerprint);
  assert.throws(() => f.state.update(job.id, { hostKeyFingerprint: different }), (error) => error.code === "SSH_HOST_KEY_CHANGED");
  assert.throws(() => f.state.pinFingerprint(settings.host, 22, "unknown-key"), (error) => error.code === "INVALID_PROVISIONING_INPUT");
});

test("failed targets require retrying the same durable job instead of creating another Host", async (t) => {
  const f = await fixture(t);
  const first = f.state.create({ adminId: f.adminId, requestId: "failed", input: settings }).job;
  f.state.update(first.id, { status: "failed", errorCode: "SSH_CONNECT_FAILED", message: "SSH 连接失败" });
  assert.throws(() => f.state.create({ adminId: f.adminId, requestId: "new-attempt", input: settings }), (error) => error.code === "PROVISIONING_RETRY_REQUIRED" && error.jobId === first.id);
  assert.equal(f.state.retry(first.id).status, "queued");
  f.state.interruptPending();
  assert.throws(() => f.state.create({ adminId: f.adminId, requestId: "new-again", input: settings }), (error) => error.code === "PROVISIONING_RETRY_REQUIRED");
  assert.equal(f.state.list().length, 1);
  assert.throws(() => f.state.update(first.id, { progress: 101 }), (error) => error.code === "INVALID_PROVISIONING_INPUT");
  assert.throws(() => f.state.update(first.id, { result: { protocolChecks: [{ type: "shadowsocks", state: "available", latencyMs: -1 }] } }), (error) => error.code === "INVALID_PROVISIONING_INPUT");
  assert.throws(() => f.state.update("missing", {}), (error) => error.statusCode === 404);
  assert.equal(f.state.get("missing"), null);
  assert.throws(() => f.state.list(0), (error) => error.code === "INVALID_PROVISIONING_INPUT");
});

test("a retry request cannot restart its failed attempt again after a lost response or process restart", async (t) => {
  const f = await fixture(t);
  const job = f.state.create({ adminId: f.adminId, requestId: "initial", input: settings }).job;
  f.state.update(job.id, { status: "failed" });
  const identity = { requestId: "retry-once", adminId: f.adminId };
  assert.equal(f.state.retry(job.id, identity).status, "queued");
  f.state.update(job.id, { status: "failed" });
  f.reopen();
  assert.equal(f.state.retry(job.id, identity).status, "failed");
  const other = f.state.create({ adminId: f.adminId, requestId: "other", input: { ...settings, port: 2222 } }).job;
  f.state.update(other.id, { status: "failed" });
  assert.throws(() => f.state.retry(other.id, identity), (error) => error.code === "PROVISIONING_REQUEST_CONFLICT");
  assert.equal(f.state.get(other.id).status, "failed");
  assert.equal(f.state.retry(job.id, { ...identity, requestId: "retry-twice" }).status, "queued");
});
