import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";

test("simultaneous owner demotions on separate database connections preserve one owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-owner-race-"));
  const options = { dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "test-password-123", seedDemoData: false };
  const store = new RayLinkStore(options);
  const second = store.createAdmin({ username: "second", password: "{{SECRET_re50tclv}}", role: "owner" });
  const first = store.listAdmins().find((admin) => admin.id !== second.id);
  const workers = [first, second].map((admin) => new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { RayLinkStore } = await import(workerData.moduleUrl);
      const store = new RayLinkStore(workerData.options);
      parentPort.once("message", () => {
        try {
          store.updateAdmin(workerData.id, { role: "operator", password: "changed-password-123" });
          parentPort.postMessage({ ok: true });
        } catch (error) {
          parentPort.postMessage({ code: error.code, message: error.message });
        } finally { store.close(); }
      });
      parentPort.postMessage({ ready: true });
    })();
  `, { eval: true, workerData: { options, id: admin.id, moduleUrl: new URL("../server/database.js", import.meta.url).href } }));
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); store.close(); await rm(directory, { recursive: true, force: true }); });
  await Promise.all(workers.map((worker) => once(worker, "message")));
  const completed = workers.map((worker) => once(worker, "message"));
  workers.forEach((worker) => worker.postMessage("demote"));
  const results = (await Promise.all(completed)).map(([result]) => result);
  assert.equal(store.listAdmins().filter((admin) => admin.role === "owner").length, 1);
  assert.equal(results.filter((result) => result.code === "LAST_OWNER_REQUIRED").length, 1);
});
