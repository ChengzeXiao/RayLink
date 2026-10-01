import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";
import { NodeProvisioning } from "../server/node-provisioning.js";

test("controller power loss retains the Host binding and pending enrollment token; incompatible Runtime never activates", { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-provision-restart-"));
  const dbPath = join(directory, "store.db");
  let store, manager;
  const child = fork(new URL("./fixtures/node-provisioning-restart-child.mjs", import.meta.url), [], {
    env: { ...process.env, PROVISIONING_TEST_DB: dbPath }, stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    await manager?.close(); store?.close(); await rm(directory, { recursive: true, force: true });
  });
  const messages = await new Promise((resolve, reject) => {
    const received = {};
    const timeout = setTimeout(() => reject(new Error("Child did not reach installer boundary")), 7000);
    child.on("message", (message) => {
      received[message.type] = message;
      if (received.job && received["installer-bound"]) { clearTimeout(timeout); resolve(received); }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("Child exited before installer boundary")); });
  });
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const original = messages["installer-bound"];
  const jobId = messages.job.jobId;
  store = new RayLinkStore({ dbPath, adminUsername: "admin", adminPassword: "restart-test-password", seedDemoData: false });
  let activationCount = 0, installationCount = 0;
  manager = new NodeProvisioning({ store, publicOrigin: () => "https://panel.example.com", pollMs: 5, waitMs: 1000,
    activate: async () => { activationCount++; throw new Error("Incompatible Runtime must never publish"); },
    sshBootstrap: { async connect() {
      return { fingerprint: `SHA256:${"a".repeat(43)}`, close() {},
        async preflight() { return { existing: { hostId: original.hostId, server: "https://panel.example.com", enrolled: false } }; },
        async install(input) {
          installationCount++;
          assert.equal(input.hostId, original.hostId);
          assert.equal(input.enrollmentToken, undefined, "retry must keep the original pending enrollment token");
          const enrolled = store.enrollNode(original.enrollmentToken, { runtimeVersion: "1.13.12", buildTags: [], agentVersion: "0.7.0" });
          assert.equal(enrolled.hostId, original.hostId);
        }
      };
    } }
  });
  assert.equal(manager.get(jobId).status, "interrupted");
  assert.equal(manager.get(jobId).hostId, original.hostId);
  manager.retry(jobId, { requestId: "restart-explicit-retry", password: "replacement-ssh-secret" }, store.listAdmins()[0].id);
  let result;
  for (let attempt = 0; attempt < 200; attempt++) {
    result = manager.get(jobId);
    if (!["queued", "running"].includes(result.status)) break;
    await delay(5);
  }
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "PROVISIONING_CAPABILITIES");
  assert.equal(result.hostId, original.hostId);
  assert.equal(installationCount, 1);
  assert.equal(activationCount, 0);
  assert.deepEqual(store.listHosts().filter((host) => host.kind === "remote").map((host) => host.id), [original.hostId]);
  assert.equal(manager.list().length, 1);
});
