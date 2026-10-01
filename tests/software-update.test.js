import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SystemUpdateManager } from "../server/system-update.js";
import { NodeSoftwareUpdater, readSoftwareUpdateJob } from "../web/node/software-update.mjs";
const execFile = promisify(execFileCallback);

async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "raylink-software-update-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "deploy"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.2.33" }));
  await writeFile(join(dir, "deploy/install.sh"), "#!/bin/bash\nexit 0\n");
  await writeFile(join(dir, "environment"), "");
  const calls = [];
  const options = { dataDir: dir, installRoot: dir, environmentFile: join(dir, "environment"), platform: "linux", architecture: "x64", runtimeMode: "systemd",
    runner: async (...args) => { calls.push(args); return { stdout: "" }; },
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: "v0.2.34", assets: ["raylink-0.2.34-linux-amd64.tar.gz", "raylink-0.2.34-linux-amd64.tar.gz.sha256"].map(name => ({ name })) }) }), ...overrides };
  return { dir, calls, options, manager: new SystemUpdateManager(options) };
}

test("control-plane update runs independently and reports the same durable job after a restart", async (t) => {
  const { manager, options, calls, dir } = await fixture(t);
  assert.equal((await manager.check()).updateAvailable, true);
  assert.equal((await manager.upgrade()).task.status, "queued");
  assert.equal(calls[0][0], "systemd-run");
  const descriptorPath = calls[0][1].at(-1);
  const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
  assert.equal(descriptor.targetVersion, "0.2.34");
  assert.equal(descriptor.releaseBaseUrl, "https://github.com/ZaneClaw/RayLink/releases/download");
  assert.ok(descriptorPath.startsWith(join(dir, "system-updates")));
  assert.equal((await new SystemUpdateManager(options).status()).task.status, "queued");
  await assert.rejects(manager.upgrade(), { code: "SYSTEM_UPDATE_BUSY" });
});

test("an incomplete release, unsupported platform, or failed release check cannot start an update", async (t) => {
  const f = await fixture(t, { fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: "v0.2.34", assets: [] }) }) });
  assert.equal((await f.manager.check()).updateAvailable, false);
  await assert.rejects(f.manager.upgrade(), { code: "SYSTEM_ALREADY_CURRENT" });
  await assert.rejects(new SystemUpdateManager({ ...f.options, platform: "darwin" }).upgrade(), { code: "SYSTEM_UPDATE_UNSUPPORTED" });
  await assert.rejects(new SystemUpdateManager({ ...f.options, fetchImpl: async () => ({ ok: false, status: 503 }) }).upgrade(), { code: "SYSTEM_UPDATE_CHECK_FAILED" });
  assert.equal(f.calls.length, 0);
});

test("failed dispatch and a vanished worker become retryable failed jobs", async (t) => {
  const f = await fixture(t, { runner: async () => { throw new Error("systemd unavailable"); } });
  await assert.rejects(f.manager.upgrade(), /systemd/);
  assert.equal((await f.manager.status()).task.status, "failed");
  const pointer = JSON.parse(await readFile(join(f.dir, "system-updates/latest.json"), "utf8"));
  await writeFile(join(pointer.jobDir, "status.json"), JSON.stringify({ status: "running", startedAt: "2020-01-01T00:00:00Z" }));
  for (const failure of [Object.assign(new Error("timeout"), { code: "ETIMEDOUT", killed: true }), new Error("D-Bus unavailable")]) {
    assert.equal((await readSoftwareUpdateJob(pointer.jobDir, async () => { throw failure; })).status, "running");
  }
  assert.equal((await readSoftwareUpdateJob(pointer.jobDir, async () => { throw Object.assign(new Error("inactive"), { code: 3 }); })).stage, "interrupted");
});

test("Node updates only use the enrolled HTTPS origin and survive dispatch interruption", async (t) => {
  const f = await fixture(t);
  const node = new NodeSoftwareUpdater({ server: "https://panel.example.com", dataDir: f.dir, runner: f.options.runner });
  assert.equal((await node.result("interrupted-job")).status, "failed");
  await assert.rejects(node.schedule({ id: "test-job", payload: { targetVersion: "0.9.0" } }), /校验/);
  await node.schedule({ id: "test-job", payload: { targetVersion: "0.9.0", scriptSha256: "a".repeat(64) } });
  assert.equal(await node.result("test-job"), null);
  const descriptor = JSON.parse(await readFile(f.calls[0][1].at(-1), "utf8"));
  assert.equal(descriptor.server, "https://panel.example.com");
  assert.equal(descriptor.dataRoot, f.dir);
  await assert.rejects(new NodeSoftwareUpdater({ server: "http://panel.example.com", dataDir: f.dir }).schedule({}), /HTTPS/);
});

test("an uncertain systemd dispatch retains the durable lock and never overwrites a worker result", async (t) => {
  for (const observed of ["queued", "running", "succeeded"]) {
    const f = await fixture(t, { runner: async (_command, args) => {
      const descriptor = JSON.parse(await readFile(args.at(-1), "utf8"));
      const statusPath = join(descriptor.jobDir, "status.json");
      const prior = JSON.parse(await readFile(statusPath, "utf8"));
      await writeFile(statusPath, JSON.stringify({ ...prior, status: observed }));
      throw Object.assign(new Error("timed out after acceptance"), { code: "ETIMEDOUT", killed: true });
    } });
    assert.equal((await f.manager.upgrade()).task.status, observed);
    if (observed !== "succeeded") await assert.rejects(f.manager.upgrade(), { code: "SYSTEM_UPDATE_BUSY" });
  }
});

test("a Node update retains its pinned control-plane CA across the independent worker", async (t) => {
  const f = await fixture(t);
  const caPath = join(f.dir, "control-plane-ca.pem");
  const node = new NodeSoftwareUpdater({ server: "https://panel.example.com", dataDir: f.dir, caPath, runner: f.options.runner });
  await node.schedule({ id: "pinned-ca", payload: { targetVersion: "0.9.0", scriptSha256: "b".repeat(64) } });
  const args = f.calls[0][1];
  assert.ok(args.includes(`--setenv=NODE_EXTRA_CA_CERTS=${caPath}`));
  const descriptor = JSON.parse(await readFile(args.at(-1), "utf8"));
  assert.equal(descriptor.caPath, caPath);
  assert.equal(args.some(value => value.includes("NODE_TLS_REJECT_UNAUTHORIZED")), false);
});

for (const succeeds of [true, false]) test(`the independent update worker reports actual ${succeeds ? "verified completion" : "installer failure"}`, async (t) => {
  const { dir } = await fixture(t);
  const jobDir = join(dir, "job");
  const bin = join(dir, "bin");
  await mkdir(jobDir); await mkdir(bin);
  await writeFile(join(bin, "systemctl"), "#!/bin/sh\n[ \"$1\" = is-active ] && [ \"$3\" = raylink.service ]\n", { mode: 0o755 });
  await writeFile(join(jobDir, "install.sh"), succeeds
    ? '#!/bin/sh\nprintf \'%s\\n\' \'{"version":"0.2.34"}\' > "$RAYLINK_INSTALL_ROOT/package.json"\n'
    : "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  await copyFile(new URL("../web/node/software-update.mjs", import.meta.url), join(jobDir, "runner.mjs"));
  const descriptor = join(jobDir, "job.json");
  await writeFile(descriptor, JSON.stringify({ kind: "control-plane", targetVersion: "0.2.34", root: dir, dataRoot: dir, jobDir, releaseBaseUrl: "https://example.invalid", nodeBinary: process.execPath }));
  const execution = execFile(process.execPath, [join(jobDir, "runner.mjs"), "--job", descriptor], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 10_000 });
  if (succeeds) await execution; else await assert.rejects(execution);
  const status = JSON.parse(await readFile(join(jobDir, "status.json"), "utf8"));
  assert.equal(status.status, succeeds ? "succeeded" : "failed");
  assert.doesNotMatch(status.message, /已恢复|由升级器恢复/);
  assert.equal(JSON.parse(await readFile(join(dir, "package.json"), "utf8")).version, succeeds ? "0.2.34" : "0.2.33");
});
