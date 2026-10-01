import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = new URL("../web/node/install.sh", import.meta.url).pathname;
const enrollmentToken = "test-enrollment-token-0000000000";

async function fixture(t, { enrolled = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-ssh-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "program");
  const config = join(directory, "config");
  const data = join(directory, "data");
  const units = join(directory, "systemd");
  const runtime = join(directory, "runtime-bin");
  const tmpfiles = join(directory, "tmpfiles");
  const bin = join(directory, "commands");
  const log = join(directory, "commands.log");
  for (const path of [join(root, "node", "bin"), config, data, units, runtime, tmpfiles, bin]) await mkdir(path, { recursive: true });
  await symlink(process.execPath, join(root, "node", "bin", "node"));
  const commands = {
    id: '#!/bin/sh\nprintf "0\\n"\n',
    uname: '#!/bin/sh\nif [ "$1" = -s ]; then printf "Linux\\n"; else printf "x86_64\\n"; fi\n',
    ss: '#!/bin/sh\nexit 0\n',
    systemctl: `#!/bin/sh
printf 'systemctl %s\n' "$*" >> "$INSTALL_TEST_LOG"
if [ "$1" = list-unit-files ]; then [ "\${INSTALL_TEST_OFFICIAL_ENABLED:-false}" = true ]; exit $?; fi
if [ "$1" = is-enabled ]; then [ "\${INSTALL_TEST_OFFICIAL_ENABLED:-false}" = true ]; exit $?; fi
if [ "$1" = is-active ]; then
  case "$*" in
    *raylink-node.service*) [ "\${INSTALL_TEST_NODE_ACTIVE:-false}" = true ] ;;
    *raylink-sing-box.service*) [ "\${INSTALL_TEST_RUNTIME_ACTIVE:-false}" = true ] ;;
    *) exit 3 ;;
  esac
fi
`,
    curl: '#!/bin/sh\nprintf "curl %s\\n" "$*" >> "$INSTALL_TEST_LOG"\nexit 22\n',
    'systemd-tmpfiles': '#!/bin/sh\nprintf "tmpfiles %s\\n" "$*" >> "$INSTALL_TEST_LOG"\n'
  };
  for (const [name, source] of Object.entries(commands)) {
    await writeFile(join(bin, name), source);
    await chmod(join(bin, name), 0o755);
  }
  const original = {
    [join(config, "node.env")]: `RAYLINK_SERVER=https://panel.example.com\nRAYLINK_ENROLL_TOKEN=${enrollmentToken}\nRAYLINK_NODE_STATE=${config}/node.json\nRAYLINK_NODE_DATA=${data}\n`,
    [join(data, "config.json")]: '{"existing":"runtime"}',
    [join(runtime, "raylink-sing-box")]: "existing-runtime",
    [join(root, "raylink-node.mjs")]: "existing-node-program",
    [join(units, "raylink-node.service")]: "existing-node-unit",
    [join(units, "raylink-sing-box.service")]: "existing-runtime-unit"
  };
  if (enrolled) original[join(config, "node.json")] = JSON.stringify({ hostId: "existing-host", nodeSecret: "existing-node-secret" });
  for (const [path, content] of Object.entries(original)) await writeFile(path, content);
  await chmod(join(runtime, "raylink-sing-box"), 0o755);
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, RAYLINK_NODE_ROOT: root,
    RAYLINK_NODE_CONFIG_ROOT: config, RAYLINK_NODE_DATA_ROOT: data,
    RAYLINK_SYSTEMD_ROOT: units, RAYLINK_TMPFILES_ROOT: tmpfiles, RAYLINK_RUNTIME_BIN_DIR: runtime,
    RAYLINK_SERVER: "https://panel.example.com", RAYLINK_ENROLL_TOKEN: "", RAYLINK_EXPECT_HOST_ID: "existing-host",
    INSTALL_TEST_LOG: log, INSTALL_TEST_NODE_ACTIVE: "false", INSTALL_TEST_RUNTIME_ACTIVE: "false"
  };
  return { directory, root, config, data, units, runtime, tmpfiles, bin, original, env,
    async run(overrides = {}) {
      let result;
      try { result = await exec("bash", [script], { env: { ...env, ...overrides }, timeout: 10_000 }); }
      catch (error) { result = error; }
      return { result, commands: await readFile(log, "utf8").catch(() => "") };
    },
    async assertPreserved() {
      for (const [path, content] of Object.entries(original)) assert.equal(await readFile(path, "utf8"), content, path);
    }
  };
}

test("retrying an enrolled matching Node succeeds without an enrollment token or changing its Runtime", async (t) => {
  const f = await fixture(t);
  const { result, commands } = await f.run({ INSTALL_TEST_NODE_ACTIVE: "true", INSTALL_TEST_RUNTIME_ACTIVE: "true" });
  assert.ok(!(result instanceof Error), result.stderr || result.message);
  assert.match(result.stdout, /已接入/);
  assert.doesNotMatch(commands, /curl|start|restart|enable|stop/);
  await f.assertPreserved();
});

test("retrying an enrolled inactive Node starts only its agent and preserves its running Runtime", async (t) => {
  const f = await fixture(t);
  const { result, commands } = await f.run({ INSTALL_TEST_RUNTIME_ACTIVE: "true" });
  assert.ok(!(result instanceof Error), result.stderr || result.message);
  assert.match(commands, /enable raylink-node.service/);
  assert.match(commands, /start raylink-node.service/);
  assert.doesNotMatch(commands, /curl|restart|stop|(?:enable|start) raylink-sing-box/);
  await f.assertPreserved();
});

test("matching IPv6 HTTPS control-plane origins remain valid during installer retries", async (t) => {
  const f = await fixture(t);
  const origin = "https://[2001:db8::1]:9443";
  const path = join(f.config, "node.env");
  f.original[path] = f.original[path].replace("https://panel.example.com", origin);
  await writeFile(path, f.original[path]);
  const { result } = await f.run({ RAYLINK_SERVER: origin, INSTALL_TEST_NODE_ACTIVE: "true" });
  assert.ok(!(result instanceof Error), result.stderr || result.message);
  await f.assertPreserved();
});

for (const mismatch of ["server", "host", "malformed-state"]) {
  test(`installer refuses an existing Node with ${mismatch} mismatch before mutation`, async (t) => {
    const f = await fixture(t);
    if (mismatch === "malformed-state") {
      const path = join(f.config, "node.json");
      f.original[path] = '{"hostId":"existing-host"}';
      await writeFile(path, f.original[path]);
    }
    const { result, commands } = await f.run(mismatch === "server"
      ? { RAYLINK_SERVER: "https://foreign.example.com" }
      : mismatch === "host" ? { RAYLINK_EXPECT_HOST_ID: "other-host" } : {});
    assert.ok(result instanceof Error);
    assert.match(result.stderr, /拒绝覆盖/);
    assert.doesNotMatch(commands, /curl|start|restart|enable|stop/);
    await f.assertPreserved();
  });
}

test("pending same-Host retry preserves its original token and starts only Node", async (t) => {
  const f = await fixture(t, { enrolled: false });
  const path = join(f.config, "node.env");
  f.original[path] += "RAYLINK_EXPECT_HOST_ID=existing-host\n";
  await writeFile(path, f.original[path]);
  const { result, commands } = await f.run({ RAYLINK_ENROLL_TOKEN: "replacement_token_must_not_overwrite_original" });
  assert.ok(!(result instanceof Error), result.stderr || result.message);
  assert.match(commands, /enable raylink-node.service/);
  assert.match(commands, /start raylink-node.service/);
  assert.doesNotMatch(commands, /curl|restart|stop|(?:start|enable) raylink-sing-box/);
  await f.assertPreserved();
});

test("pending legacy installation without a Host binding is not silently adopted", async (t) => {
  const f = await fixture(t, { enrolled: false });
  const { result, commands } = await f.run({ RAYLINK_ENROLL_TOKEN: enrollmentToken });
  assert.ok(result instanceof Error);
  assert.match(result.stderr, /缺少预期主机绑定/);
  assert.doesNotMatch(commands, /curl|start|restart|enable|stop/);
  await f.assertPreserved();
});

test("installer refuses a mismatched state path instead of reading an unrelated identity", async (t) => {
  const f = await fixture(t);
  const path = join(f.config, "node.env");
  f.original[path] = f.original[path].replace(`${f.config}/node.json`, `${f.config}/other-node.json`);
  await writeFile(path, f.original[path]);
  const { result, commands } = await f.run();
  assert.ok(result instanceof Error);
  assert.match(result.stderr, /状态路径/);
  assert.doesNotMatch(commands, /curl|start|restart|enable|stop/);
  await f.assertPreserved();
});

async function freshFixture(t, { failAsset = "" } = {}) {
  const f = await fixture(t, { enrolled: false });
  for (const path of Object.keys(f.original)) await rm(path);
  const assets = join(f.directory, "assets");
  await mkdir(assets);
  const runtimeName = "raylink-sing-box-1.14.2-linux-amd64";
  const cronetName = "raylink-libcronet-1.14.2-linux-amd64.so";
  const runtime = '#!/bin/sh\nprintf "sing-box version 1.14.2\\nTags: with_gvisor,with_quic,with_dhcp,with_wireguard,with_utls,with_acme,with_clash_api,with_tailscale,with_ccm,with_ocm,with_naive_outbound,with_v2ray_api,with_purego,badlinkname,tfogo_checklinkname0\\n"\n';
  const contents = {
    "raylink-node.mjs": 'export const AGENT_VERSION = "test";\n',
    "raylink-ufw.tmpfiles.conf": "f /run/ufw.lock 0644 root root -\n",
    [runtimeName]: runtime,
    [cronetName]: "fixture-cronet"
  };
  for (const [name, content] of Object.entries(contents)) await writeFile(join(assets, name), content);
  for (const name of [runtimeName, cronetName]) {
    await writeFile(join(assets, `${name}.sha256`), `${createHash("sha256").update(contents[name]).digest("hex")}  ${name}\n`);
  }
  await writeFile(join(f.bin, "curl"), `#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$INSTALL_TEST_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in https://*|http://*) asset="\${1##*/}" ;; -o) shift; output="$1" ;; esac
  shift
done
if [ "$asset" = "$INSTALL_TEST_FAIL_ASSET" ]; then printf partial-download > "$output"; exit 22; fi
cp "$INSTALL_TEST_ASSETS/$asset" "$output"
`);
  await chmod(join(f.bin, "curl"), 0o755);
  f.env.RAYLINK_ENROLL_TOKEN = enrollmentToken;
  f.env.INSTALL_TEST_ASSETS = assets;
  f.env.INSTALL_TEST_FAIL_ASSET = failAsset;
  return f;
}

test("failed staged download leaves fresh install ownership, programs and services untouched", async (t) => {
  const f = await freshFixture(t, { failAsset: "raylink-node.mjs" });
  const { result, commands } = await f.run();
  assert.ok(result instanceof Error);
  for (const path of [join(f.root, "raylink-node.mjs"), join(f.config, "node.env"), join(f.units, "raylink-node.service"), join(f.tmpfiles, "raylink-node-ufw.conf")]) {
    await assert.rejects(stat(path), { code: "ENOENT" });
  }
  assert.match(commands, /--connect-timeout 10 --max-time 180 --retry 2/);
  assert.match(commands, /--proto =https --proto-redir =https/);
  assert.doesNotMatch(commands, /systemctl (?:start|restart|enable|stop)|tmpfiles --create/);
});

test("explicit loopback HTTP development installs allow only their initial HTTP request and require HTTPS redirects", async (t) => {
  const f = await freshFixture(t);
  const { result, commands } = await f.run({ RAYLINK_SERVER: "http://127.0.0.1:3000", RAYLINK_ALLOW_INSECURE_HTTP: "true" });
  assert.ok(!(result instanceof Error), result.stderr || result.message);
  assert.match(commands, /curl .*http:\/\/127\.0\.0\.1:3000\/node\/.*--proto =http,https --proto-redir =https/);
  assert.match(await readFile(join(f.config, "node.env"), "utf8"), /RAYLINK_SERVER=http:\/\/127\.0\.0\.1:3000/);
});

test("fresh staged install persists Host binding and a same-Host retry leaves every artifact intact", async (t) => {
  const f = await freshFixture(t);
  const { result, commands } = await f.run();
  assert.ok(!(result instanceof Error), result.stderr || result.message);
  const environment = await readFile(join(f.config, "node.env"), "utf8");
  assert.match(environment, /RAYLINK_EXPECT_HOST_ID=existing-host/);
  assert.ok(environment.includes(`RAYLINK_ENROLL_TOKEN=${enrollmentToken}`));
  assert.equal((await stat(join(f.config, "node.env"))).mode & 0o777, 0o600);
  assert.match(commands, /systemctl start raylink-node.service/);
  assert.doesNotMatch(commands, /enable --now|(?:start|restart) raylink-sing-box/);
  const paths = [join(f.config, "node.env"), join(f.root, "raylink-node.mjs"), join(f.runtime, "raylink-sing-box"), join(f.runtime, "libcronet.so"), join(f.units, "raylink-sing-box.service")];
  const before = await Promise.all(paths.map((path) => readFile(path)));
  const again = await f.run({ RAYLINK_ENROLL_TOKEN: "new_token_must_be_ignored_on_retry", INSTALL_TEST_NODE_ACTIVE: "true" });
  assert.ok(!(again.result instanceof Error), again.result.stderr || again.result.message);
  const after = await Promise.all(paths.map((path) => readFile(path)));
  assert.deepEqual(after, before);
});

test("fresh installation refuses an enabled foreign Runtime even when it is currently stopped", async (t) => {
  const f = await freshFixture(t);
  const { result, commands } = await f.run({ INSTALL_TEST_OFFICIAL_ENABLED: "true" });
  assert.ok(result instanceof Error);
  assert.match(result.stderr, /sing-box.service/);
  assert.doesNotMatch(commands, /curl|systemctl (?:start|restart|enable|disable|stop)/);
  await assert.rejects(stat(join(f.config, "node.env")), { code: "ENOENT" });
});

test("retry repairs an interrupted pending installation while preserving its original enrollment environment", async (t) => {
  const f = await freshFixture(t);
  const path = join(f.config, "node.env");
  const original = `RAYLINK_SERVER=https://panel.example.com\nRAYLINK_ENROLL_TOKEN=${enrollmentToken}\nRAYLINK_EXPECT_HOST_ID=existing-host\nRAYLINK_NODE_STATE=${f.config}/node.json\nRAYLINK_NODE_DATA=${f.data}\n`;
  await writeFile(path, original, { mode: 0o600 });
  const { result, commands } = await f.run({ RAYLINK_ENROLL_TOKEN: "" });
  assert.ok(!(result instanceof Error), result.stderr || result.message);
  assert.equal(await readFile(path, "utf8"), original);
  assert.match(await readFile(join(f.units, "raylink-node.service"), "utf8"), /Description=RayLink Node/);
  assert.match(commands, /systemctl start raylink-node.service/);
  assert.doesNotMatch(commands, /enable --now|(?:start|restart) raylink-sing-box/);
});
