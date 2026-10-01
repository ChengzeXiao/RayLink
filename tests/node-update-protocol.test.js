import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkNode } from "../web/node/raylink-node.mjs";
import { NodeSoftwareUpdater } from "../web/node/software-update.mjs";

async function fixture(t, { schedulingFails = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-update-protocol-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const task = { id: "node-update-1", attempt: 1, kind: "upgrade-node", payload: { targetVersion: "0.9.0", scriptSha256: "a".repeat(64) } };
  const calls = { schedules: 0, heartbeats: 0, claims: 0, receipts: [], failReceipt: false };
  const statePath = join(directory, "state.json");
  const selfUpdater = new NodeSoftwareUpdater({
    server: "https://panel.example.com", dataDir: directory,
    async runner(command) {
      assert.equal(command, "systemd-run");
      calls.schedules += 1;
      if (schedulingFails) throw new Error("systemd permission denied");
      return { stdout: "" };
    }
  });
  const options = {
    serverUrl: "https://panel.example.com", enrollmentToken: "token", statePath,
    selfUpdater, metadataProvider: async () => ({ agentVersion: "0.9.0" }),
    fetchFn: async (url, init) => {
      let body;
      if (url.endsWith("/enroll")) body = { hostId: "node", nodeSecret: "test-secret" };
      else if (url.endsWith("/heartbeat")) { calls.heartbeats += 1; body = { ok: true }; }
      else if (url.endsWith("/next")) { calls.claims += 1; body = calls.claims === 1 ? task : undefined; }
      else if (url.endsWith("/complete")) {
        calls.receipts.push(JSON.parse(init.body));
        if (calls.failReceipt) { calls.failReceipt = false; throw new Error("receipt transport interrupted"); }
        body = { ok: true };
      } else throw new Error(url);
      return new Response(body === undefined ? null : JSON.stringify(body), { status: body === undefined ? 204 : 200 });
    }
  };
  return { directory, statePath, options, calls, task };
}

test("Node software update survives process replacement and retries its completion receipt without running again", async (t) => {
  const f = await fixture(t);
  await new RayLinkNode(f.options).pollOnce();
  assert.equal(f.calls.schedules, 1);
  assert.equal(f.calls.receipts.length, 0);
  await new RayLinkNode(f.options).pollOnce();
  assert.equal(f.calls.heartbeats, 2, "updating Nodes must continue reporting health");
  assert.equal(f.calls.claims, 1, "updating Nodes must not concurrently claim another task");
  await writeFile(join(f.directory, "software-updates", f.task.id, "status.json"), JSON.stringify({ status: "succeeded", targetVersion: "0.9.0" }));
  f.calls.failReceipt = true;
  await assert.rejects(new RayLinkNode(f.options).pollOnce(), /receipt transport interrupted/);
  await new RayLinkNode(f.options).pollOnce();
  assert.equal(f.calls.schedules, 1);
  assert.deepEqual(f.calls.receipts.at(-1), { attempt: 1, status: "succeeded", result: { agentVersion: "0.9.0" } });
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.pendingNodeUpgrade, undefined);
  assert.equal(state.pendingTaskReceipt, undefined);
});

test("a rejected systemd update dispatch fails the task and unblocks later Node work", async (t) => {
  const f = await fixture(t, { schedulingFails: true });
  const node = new RayLinkNode(f.options);
  await node.pollOnce();
  assert.equal(f.calls.receipts[0].status, "failed");
  assert.match(f.calls.receipts[0].result.error, /systemd/);
  await node.pollOnce();
  assert.equal(f.calls.claims, 2);
});
