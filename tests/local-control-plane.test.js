import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";

test("local control plane persists real data and credentials across restarts without demo nodes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-local-service-"));
  const probe = createServer(); await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  let child;
  const stop = async () => { if (!child || child.exitCode !== null) return; const closed = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await closed; };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(process.execPath, ["deploy/run-local.mjs"], { cwd: new URL("..", import.meta.url),
      env: { ...process.env, RAYLINK_LOCAL_DATA_DIR: directory, RAYLINK_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Local server did not start: ${output}`)), 15_000);
      child.stdout.on("data", data => { output += data; if (output.includes("Local control plane listening")) { clearTimeout(timer); resolve(); } });
      child.stderr.on("data", data => { output += data; });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Local server exited ${code}: ${output}`)); });
    });
    const identity = JSON.parse(await readFile(join(directory, "local-credentials.json"), "utf8"));
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: identity.username, password: identity.password }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie()[0].split(";")[0];
    return { identity, api: (path, method = "GET", body) => fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { cookie, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }) };
  };
  const first = await start();
  const bootstrap = await (await first.api("/api/bootstrap")).json();
  assert.equal(bootstrap.users.length, 0);
  assert.deepEqual(bootstrap.hosts.map(host => host.kind), ["local"]);
  assert.equal(bootstrap.provisioning.canStart, false);
  const created = await first.api("/api/users", "POST", { name: "Persistent", email: "persistent@example.com", quotaGb: 100, nodeScope: ["all"], expiresAt: "2099-01-01", portalStatus: "active", state: "active" });
  assert.equal(created.status, 201);
  await stop();
  const second = await start();
  assert.deepEqual(second.identity, first.identity);
  assert.equal((await (await second.api("/api/bootstrap")).json()).users.length, 1);
  assert.equal((await stat(join(directory, "local-credentials.json"))).mode & 0o777, 0o600);
  const loginText = await readFile(join(directory, "initial-login.txt"), "utf8");
  assert.ok(loginText.includes(first.identity.password));
  assert.ok(!loginText.includes(first.identity.encryptionKey));
  assert.equal((await stat(join(directory, "initial-login.txt"))).mode & 0o777, 0o600);
});
