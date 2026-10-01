import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";
import { NodeProvisioning } from "../server/node-provisioning.js";

test("provisioning passes only the locally trusted public certificate to SSH preflight and installation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-provision-ca-"));
  const store = new RayLinkStore({ dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "fixture-password", seedDemoData: false });
  const forwarded = [];
  const manager = new NodeProvisioning({
    store, publicOrigin: () => "https://192.0.2.5", trustedControlPlaneCa: async () => "TRUSTED_PUBLIC_CERTIFICATE",
    sshBootstrap: { async connect() { return {
      fingerprint: `SHA256:${"a".repeat(43)}`, close() {},
      async preflight(input) { forwarded.push(input.controlPlaneCaCertificate); return { existing: null }; },
      async install(input) { forwarded.push(input.controlPlaneCaCertificate); throw Object.assign(new Error("fixture ends at installation boundary"), { code: "SSH_REMOTE_FAILED" }); }
    }; } }
  });
  t.after(async () => { await manager.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const job = manager.start({ requestId: "trusted-ca", host: "203.0.113.42", username: "root", password: "fixture-password", controlPlaneCaCertificate: "UNTRUSTED_REQUEST_CERTIFICATE" }, store.listAdmins()[0].id);
  for (let attempt = 0; attempt < 100 && ["queued", "running"].includes(manager.get(job.id).status); attempt += 1) await delay(10);
  assert.equal(manager.get(job.id).status, "failed");
  assert.deepEqual(forwarded, ["TRUSTED_PUBLIC_CERTIFICATE", "TRUSTED_PUBLIC_CERTIFICATE"]);
  assert.doesNotMatch(JSON.stringify(manager.get(job.id)), /TRUSTED_PUBLIC_CERTIFICATE|UNTRUSTED_REQUEST_CERTIFICATE/);
});
