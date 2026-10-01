import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";

test("Host BBR telemetry survives restart, uses receive time, and cannot retain an obsolete enabled state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "raylink-bbr-report-"));
  const options = { dbPath: join(dir, "store.db"), adminUsername: "admin", adminPassword: "test-bbr-telemetry-password", seedDemoData: false };
  let store = new RayLinkStore(options);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const receivedAt = "2026-10-02T01:00:00.000Z";
  store.recordHostTelemetry("local", { bbr: { status: "enabled", congestionControl: "bbr", qdisc: "fq", checkedAt: "2099-01-01" } }, receivedAt);
  assert.deepEqual(store.getHost("local").telemetry.bbr, { status: "enabled", congestionControl: "bbr", qdisc: "fq", checkedAt: receivedAt, error: null });
  store.close(); store = new RayLinkStore(options);
  assert.equal(store.listHosts()[0].telemetry.bbr.status, "enabled");
  store.recordHostTelemetry("local", { bbr: { status: "enabled", congestionControl: "cubic", qdisc: "fq" } });
  assert.equal(store.getHost("local").telemetry.bbr.status, "unavailable", "inconsistent enabled reports must not become green");
  store.recordHostTelemetry("local", {});
  assert.equal(store.getHost("local").telemetry.bbr, null, "older Nodes without BBR telemetry must report unknown");
});
