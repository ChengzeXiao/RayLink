import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
const execFile = promisify(execFileCallback);
const helper = new URL("../deploy/initial-install-state.sh", import.meta.url).pathname;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-initial-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [root, data, config, node, caddy, bin] = ["root", "data", "config", "node", "caddy", "bin"].map((name) => join(directory, name));
  await Promise.all([root, data, join(node, "bin"), caddy, bin].map((path) => mkdir(path, { recursive: true })));
  await symlink(process.execPath, join(node, "bin/node"));
  const checksumBinary = (await execFile("/bin/sh", ["-c", "command -v md5sum"])).stdout.trim();
  await symlink(checksumBinary, join(bin, "md5sum"));
  const pending = join(config, "install-pending");
  const begin = () => execFile("/bin/bash", [helper, "begin", root, data, config, node, caddy, "192.0.2.5"], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
  return { root, data, config, node, caddy, bin, pending, begin };
}

test("first installation records private ownership and resumes its own unfinished application and Caddy", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.begin()).stdout.trim(), "fresh");
  assert.equal((await stat(f.pending)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.pending, "owner"))).mode & 0o777, 0o600);
  await writeFile(join(f.root, "package.json"), '{}\n');
  await mkdir(join(f.data, "managed"));
  await writeFile(join(f.data, "managed/Caddyfile"), "owned initial config\n");
  await symlink(join(f.data, "managed/Caddyfile"), join(f.caddy, "Caddyfile"));
  assert.equal((await f.begin()).stdout.trim(), "resume");
  assert.equal(await readFile(join(f.data, "managed/Caddyfile"), "utf8"), "owned initial config\n");
});

test("resume accepts only an unmodified package Caddy configuration and preserves external changes", async (t) => {
  const f = await fixture(t);
  await f.begin();
  const contents = "default package Caddyfile\n";
  const config = join(f.caddy, "Caddyfile");
  await writeFile(config, contents);
  const digest = createHash("md5").update(contents).digest("hex");
  await writeFile(join(f.bin, "dpkg-query"), `#!/bin/sh\nprintf '%s\\n' '${config} ${digest}'\n`, { mode: 0o755 });
  assert.equal((await f.begin()).stdout.trim(), "resume");
  await writeFile(config, "external site configuration\n");
  await assert.rejects(f.begin(), (error) => /Caddy 配置已被修改/.test(error.stderr));
  assert.equal(await readFile(config, "utf8"), "external site configuration\n");
});

test("resume refuses initialized data but accepts a pending setup without changing the database", async (t) => {
  const f = await fixture(t);
  await f.begin();
  const path = join(f.data, "raylink.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('setup_state', 'SETUP_PENDING')");
  db.close();
  const before = await readFile(path);
  assert.equal((await f.begin()).stdout.trim(), "resume");
  assert.deepEqual(await readFile(path), before);
  const initialized = new DatabaseSync(path);
  initialized.prepare("UPDATE settings SET value = 'READY'").run();
  initialized.close();
  await assert.rejects(f.begin(), (error) => /数据库已完成初始化/.test(error.stderr));
  await assert.rejects(execFile("bash", [helper, "pending", f.pending, f.data, f.node]), { code: 1 }, "a stale marker must not route an initialized installation back into first setup");
});

test("installation refuses unowned existing applications and unsafe recovery markers", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "package.json"), '{}\n');
  await assert.rejects(f.begin(), (error) => /没有本次安装标记/.test(error.stderr));
  await rm(join(f.root, "package.json"));
  await f.begin();
  await chmod(f.pending, 0o755);
  await assert.rejects(f.begin(), (error) => /私有受管目录/.test(error.stderr));
});
