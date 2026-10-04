import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";

test("AI exit pin persists by Host ID and legacy routing updates cannot silently remove it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-ai-exit-"));
  const options = { dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "test-password-123", seedDemoData: false };
  let store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(store.routingPolicy().aiExit, { mode: "auto", hostId: null });
  store.updateRoutingPolicy({ aiExit: { mode: "pinned", hostId: "local" } });
  store.updateHost("local", { name: "Renamed AI Host" });
  store.updateRoutingPolicy({ mode: "smart", rules: [] });
  store.close();
  store = new RayLinkStore(options);
  assert.deepEqual(store.routingPolicy().aiExit, { mode: "pinned", hostId: "local" });
  for (const aiExit of [{ mode: "pinned", hostId: "missing" }, { mode: "pinned" }, { mode: "fastest" }, null]) {
    assert.throws(() => store.updateRoutingPolicy({ aiExit }), { code: "INVALID_AI_EXIT" });
    assert.deepEqual(store.routingPolicy().aiExit, { mode: "pinned", hostId: "local" });
  }
  assert.deepEqual(store.updateRoutingPolicy({ aiExit: { mode: "auto" } }).aiExit, { mode: "auto", hostId: null });
});
