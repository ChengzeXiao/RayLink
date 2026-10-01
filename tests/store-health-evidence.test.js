import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-evidence-"));
  const store = new RayLinkStore({ dbPath: join(directory, "store.db"), adminUsername: "admin", adminPassword: "test-password-123", seedDemoData: false });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const checked = () => store.setProtocolActivation("local", "vmess", { state: "public-ready", publicCheck: { checkedAt: new Date().toISOString(), reachable: true, probe: "sing-box-tools-fetch", healthWindow: { successRate: 100 } } });
  return { store, checked, check: () => store.getHost("local").protocolActivations.find((entry) => entry.type === "vmess")?.publicCheck };
}

test("changing a Host address invalidates endpoint evidence but a label change preserves it", async (t) => {
  const { store, checked, check } = await fixture(t);
  checked();
  store.updateHost("local", { name: "New label" });
  assert.equal(check().reachable, true);
  store.updateHost("local", { address: "new.example.com" });
  assert.ok(!check(), "the new address has never been probed");
});

test("protocol port, transport and TLS changes invalidate evidence; unchanged config preserves it", async (t) => {
  const { store, checked, check } = await fixture(t);
  checked();
  store.updateHostProtocolConfig("local", "vmess", {});
  assert.equal(check().reachable, true);
  for (const change of [
    { port: 19999 },
    { transport: { type: "ws", path: "/updated" } },
    { tls: { serverName: "updated.example.com" } }
  ]) {
    checked();
    store.updateHostProtocolConfig("local", "vmess", change);
    assert.ok(!check(), `configuration changed: ${JSON.stringify(change)}`);
  }
});
