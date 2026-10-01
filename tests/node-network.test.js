import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BbrManager } from "../web/node/network-tuning.mjs";
import { NodeTelemetryCollector, RayLinkNode } from "../web/node/raylink-node.mjs";

async function networkNode(t, { denied = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-network-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const kernel = { control: "cubic", qdisc: "fq_codel", denied };
  const manager = new BbrManager({
    mode: "systemd", platform: "linux", configPath: join(directory, "99-raylink-bbr.conf"),
    async runCommand(command, args) {
      if (command === "modprobe") return { stdout: "" };
      if (args[0] === "-p") {
        if (kernel.denied) throw new Error("permission denied");
        kernel.control = "bbr"; kernel.qdisc = "fq";
        return { stdout: "" };
      }
      return { stdout: args[1].includes("available") ? "reno cubic bbr" : args[1].includes("qdisc") ? kernel.qdisc : kernel.control };
    }
  });
  const collector = new NodeTelemetryCollector({
    bbrProvider: () => manager.inspect(), serviceProvider: async () => "running",
    sampleProvider: async () => ({ cpu: { idle: 1, total: 2 }, networkRxBytes: 0, networkTxBytes: 0 })
  });
  const heartbeats = [], receipts = [], tasks = [];
  const node = new RayLinkNode({
    serverUrl: "https://panel.example.com", enrollmentToken: "test-token",
    statePath: join(directory, "state.json"), enableBbr: true, bbrManager: manager,
    metadataProvider: async () => ({ telemetry: await collector.collect() }),
    fetchFn: async (url, init) => {
      let body;
      if (url.endsWith("/enroll")) body = { hostId: "bbr-host", nodeSecret: "test-secret" };
      else if (url.endsWith("/heartbeat")) { heartbeats.push(JSON.parse(init.body)); body = { ok: true }; }
      else if (url.endsWith("/next")) body = tasks.shift();
      else if (url.endsWith("/complete")) { receipts.push(JSON.parse(init.body)); body = { ok: true }; }
      else throw new Error(`Unexpected request ${url}`);
      return new Response(body === undefined ? null : JSON.stringify(body), { status: body === undefined ? 204 : 200 });
    }
  });
  return { node, manager, heartbeats, receipts, tasks, kernel, directory };
}

test("Node automatically persists BBR before enrollment and reports the actual kernel on each heartbeat", async (t) => {
  const f = await networkNode(t);
  await f.node.pollOnce();
  assert.deepEqual(f.heartbeats[0].telemetry.bbr, { status: "enabled", congestionControl: "bbr", qdisc: "fq" });
  assert.match(await readFile(join(f.directory, "99-raylink-bbr.conf"), "utf8"), /net.ipv4.tcp_congestion_control = bbr/);
  f.kernel.control = "cubic";
  await f.node.pollOnce();
  assert.equal(f.heartbeats[1].telemetry.bbr.status, "available", "a changed kernel must not be reported from cached success");
});

test("a denied BBR setup still enrolls and can be retried as an explicit Node task", async (t) => {
  const f = await networkNode(t, { denied: true });
  f.tasks.push({ id: "bbr-repair", attempt: 1, kind: "configure-bbr", payload: {} });
  await f.node.pollOnce();
  assert.equal(f.heartbeats[0].telemetry.bbr.status, "failed");
  assert.equal(f.receipts[0].status, "failed");
  assert.equal(f.receipts[0].result.code, "BBR_APPLY_FAILED");
  f.kernel.denied = false;
  f.tasks.push({ id: "bbr-repair", attempt: 2, kind: "configure-bbr", payload: {} });
  await f.node.pollOnce();
  assert.deepEqual(f.receipts[1], {
    attempt: 2, status: "succeeded", result: { status: "enabled", congestionControl: "bbr", qdisc: "fq" }
  });
  await f.node.pollOnce();
  assert.equal(f.heartbeats[2].telemetry.bbr.status, "enabled");
});
