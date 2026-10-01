import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";
import { NodeProvisioning } from "../server/node-provisioning.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-provision-address-"));
  const store = new RayLinkStore({ dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "address-test-password", seedDemoData: false });
  const attempts = [];
  const manager = new NodeProvisioning({ store, publicOrigin: () => "https://panel.example.com", sshBootstrap: {
    async connect(input) {
      attempts.push(input.host);
      throw Object.assign(new Error("Fixture stops at the SSH transport boundary"), { code: "SSH_AUTH_FAILED" });
    }
  } });
  t.after(async () => { await manager.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const start = (host) => manager.start({ requestId: "address-validation", host, username: "root", password: "fixture-password" }, store.listAdmins()[0].id);
  return { start, attempts };
}

for (const host of ["220.1.2.3", "221.1.2.3", "222.1.2.3", "223.1.2.3"]) {
  test(`SSH onboarding accepts unicast address ${host}`, async (t) => {
    const f = await fixture(t);
    assert.doesNotThrow(() => f.start(host));
    assert.deepEqual(f.attempts, [host]);
  });
}

for (const host of ["224.1.2.3", "255.255.255.255", "127.0.0.1", "0:0:0:0:0:0:0:1", "0:0:0:0:0:ffff:7f00:1"]) {
  test(`SSH onboarding rejects forbidden address ${host} before connecting`, async (t) => {
    const f = await fixture(t);
    assert.throws(() => f.start(host), (error) => error.code === "INVALID_PROVISIONING_INPUT");
    assert.deepEqual(f.attempts, []);
  });
}
