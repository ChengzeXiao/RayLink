import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
const exec = promisify(execFile);

async function updateNode(t, { healthFails = false, downloadFails = false, existingModules = false, savedCa = false } = {}) {
  // Resolve macOS /var aliases so the import preflight sees the same paths as
  // Linux. Otherwise a mistaken CLI entry-point match is silently masked.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "raylink-node-update-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "node");
  const bin = join(directory, "bin");
  const log = join(directory, "services.log");
  const started = join(directory, "started");
  await mkdir(join(root, "node", "bin"), { recursive: true });
  await mkdir(bin);
  const config = join(directory, "config");
  if (savedCa) {
    await mkdir(config);
    await writeFile(join(config, "control-plane-ca.pem"), "saved-public-control-plane-ca\n");
    await writeFile(join(config, "node.env"), `RAYLINK_SERVER=https://panel.example.com\nNODE_EXTRA_CA_CERTS=${config}/control-plane-ca.pem\nRAYLINK_CONTROL_CA_FILE=${config}/control-plane-ca.pem\n`);
  }
  await writeFile(join(root, "node", "bin", "node"), `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const result = spawnSync(process.execPath, process.argv.slice(2), { stdio: "inherit", env: process.env, timeout: 3000 });
if (result.error) { process.stderr.write("Node validation exceeded its deadline\\n"); process.exit(124); }
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const preserved = {
    "raylink-node.mjs": "export const AGENT_VERSION = '0.7.0';\n",
    "build-metered-runtime.sh": "#!/bin/sh\n# old builder\n",
    "state.json": '{"hostId":"existing-host","nodeSecret":"test-identity"}',
    "config.json": '{"inbounds":[]}',
    "raylink-sing-box": "existing-runtime-1.13.14",
    "libcronet.so": "existing-cronet-1.13.14"
  };
  if (existingModules) {
    preserved["network-tuning.mjs"] = "export class BbrManager {} // old\n";
    preserved["software-update.mjs"] = "export class NodeSoftwareUpdater {} // old\n";
  }
  for (const [name, contents] of Object.entries(preserved)) await writeFile(join(root, name), contents);
  const commands = {
    id: '#!/bin/sh\nprintf "0\\n"\n',
    uname: '#!/bin/sh\nprintf "Linux\\n"\n',
    sleep: '#!/bin/sh\nexit 0\n',
    systemctl: `#!/bin/sh
printf '%s\\n' "$*" >> "$NODE_TEST_LOG"
if [ "$1" = start ]; then touch "$NODE_TEST_STARTED"; fi
if [ "$1" = is-active ] && [ -f "$NODE_TEST_STARTED" ] && [ "$NODE_TEST_HEALTH_FAIL" = true ]; then exit 1; fi
`,
    curl: `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$NODE_TEST_LOG"
[ "$NODE_TEST_DOWNLOAD_FAIL" = true ] && exit 22
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://*) asset="\${1##*/}" ;;
    -o) shift; output="$1" ;;
  esac
  shift
done
cp "$NODE_TEST_SOURCE/$asset" "$output"
`
  };
  for (const [name, source] of Object.entries(commands)) {
    await writeFile(join(bin, name), source);
    await chmod(join(bin, name), 0o755);
  }
  let error;
  try {
    await exec("bash", [new URL("../web/node/upgrade.sh", import.meta.url).pathname], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RAYLINK_NODE_ROOT: root,
        RAYLINK_RUNTIME_MODE: "dry-run", RAYLINK_NODE_STATE: join(directory, "import-state.json"),
        RAYLINK_NODE_CONFIG_ROOT: join(directory, "config"), RAYLINK_SYSCTL_ROOT: join(directory, "sysctl.d"),
        RAYLINK_SERVER: "https://panel.example.com", NODE_TEST_LOG: log,
        NODE_TEST_STARTED: started, NODE_TEST_SOURCE: new URL("../web/node", import.meta.url).pathname,
        NODE_TEST_HEALTH_FAIL: String(healthFails), NODE_TEST_DOWNLOAD_FAIL: String(downloadFails) }
    });
  } catch (caught) { error = caught; }
  const services = await readFile(log, "utf8");
  assert.ok(!services.includes("raylink-sing-box"), "Node upgrade must not restart or stop the Runtime");
  for (const name of ["state.json", "config.json", "raylink-sing-box", "libcronet.so"]) {
    assert.equal(await readFile(join(root, name), "utf8"), preserved[name]);
  }
  return { root, directory, error, preserved, services };
}

test("Node-only upgrade replaces the program and builder while preserving enrollment and Runtime", async (t) => {
  const { root, directory, error, services } = await updateNode(t);
  assert.equal(error, undefined);
  for (const name of ["raylink-node.mjs", "build-metered-runtime.sh", "network-tuning.mjs", "software-update.mjs"]) {
    assert.equal(await readFile(join(root, name), "utf8"), await readFile(new URL(`../web/node/${name}`, import.meta.url), "utf8"));
  }
  assert.match(services, /stop raylink-node.service\nstart raylink-node.service/);
  assert.equal(await readlink(join(directory, "sysctl.d", "99-raylink-node-bbr.conf")), join(directory, "config", "99-raylink-bbr.conf"));
});

test("Node-only upgrade rolls back the program and builder after a failed restart", async (t) => {
  const { root, error, preserved } = await updateNode(t, { healthFails: true });
  assert.ok(error);
  for (const name of ["raylink-node.mjs", "build-metered-runtime.sh"]) {
    assert.equal(await readFile(join(root, name), "utf8"), preserved[name]);
  }
  for (const name of ["network-tuning.mjs", "software-update.mjs"]) await assert.rejects(readFile(join(root, name)), { code: "ENOENT" });
});

test("Node upgrade restores previous network and update modules when the new service fails", async (t) => {
  const { root, error, preserved } = await updateNode(t, { healthFails: true, existingModules: true });
  assert.ok(error);
  for (const name of ["network-tuning.mjs", "software-update.mjs"]) assert.equal(await readFile(join(root, name), "utf8"), preserved[name]);
});

test("a failed Node download leaves the running service and files untouched", async (t) => {
  const { root, error, preserved, services } = await updateNode(t, { downloadFails: true });
  assert.ok(error);
  assert.ok(!services.includes("stop "));
  assert.equal(await readFile(join(root, "raylink-node.mjs"), "utf8"), preserved["raylink-node.mjs"]);
});

test("a Node upgrade reads the saved control-plane CA and preserves its trust configuration", async (t) => {
  const { directory, error, services } = await updateNode(t, { savedCa: true });
  assert.equal(error, undefined);
  const ca = join(directory, "config", "control-plane-ca.pem");
  const downloads = services.split("\n").filter((line) => line.startsWith("curl "));
  assert.equal(downloads.length, 4);
  assert.ok(downloads.every((line) => line.includes(`--cacert ${ca}`)));
  assert.doesNotMatch(services, /(?:^|\s)(?:-k|--insecure)(?:\s|$)/);
  assert.equal(await readFile(ca, "utf8"), "saved-public-control-plane-ca\n");
  assert.match(await readFile(join(directory, "config", "node.env"), "utf8"), /NODE_EXTRA_CA_CERTS=/);
});

test("a failed Node upgrade restores its prior control-plane CA and environment exactly", async (t) => {
  const { directory, error } = await updateNode(t, { savedCa: true, healthFails: true });
  assert.ok(error);
  const config = join(directory, "config");
  assert.equal(await readFile(join(config, "control-plane-ca.pem"), "utf8"), "saved-public-control-plane-ca\n");
  assert.equal(await readFile(join(config, "node.env"), "utf8"), `RAYLINK_SERVER=https://panel.example.com\nNODE_EXTRA_CA_CERTS=${config}/control-plane-ca.pem\nRAYLINK_CONTROL_CA_FILE=${config}/control-plane-ca.pem\n`);
});
