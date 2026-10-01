import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
const exec = promisify(execFile);

async function updateNode(t, { healthFails = false, downloadFails = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "node");
  const bin = join(directory, "bin");
  const log = join(directory, "services.log");
  const started = join(directory, "started");
  await mkdir(join(root, "node", "bin"), { recursive: true });
  await mkdir(bin);
  await symlink(process.execPath, join(root, "node", "bin", "node"));
  const preserved = {
    "raylink-node.mjs": "export const AGENT_VERSION = '0.7.0';\n",
    "build-metered-runtime.sh": "#!/bin/sh\n# old builder\n",
    "state.json": '{"hostId":"existing-host","nodeSecret":"test-identity"}',
    "config.json": '{"inbounds":[]}',
    "raylink-sing-box": "existing-runtime-1.13.14",
    "libcronet.so": "existing-cronet-1.13.14"
  };
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
  return { root, error, preserved, services };
}

test("Node-only upgrade replaces the program and builder while preserving enrollment and Runtime", async (t) => {
  const { root, error, services } = await updateNode(t);
  assert.equal(error, undefined);
  for (const name of ["raylink-node.mjs", "build-metered-runtime.sh"]) {
    assert.equal(await readFile(join(root, name), "utf8"), await readFile(new URL(`../web/node/${name}`, import.meta.url), "utf8"));
  }
  assert.match(services, /stop raylink-node.service\nstart raylink-node.service/);
});

test("Node-only upgrade rolls back the program and builder after a failed restart", async (t) => {
  const { root, error, preserved } = await updateNode(t, { healthFails: true });
  assert.ok(error);
  for (const name of ["raylink-node.mjs", "build-metered-runtime.sh"]) {
    assert.equal(await readFile(join(root, name), "utf8"), preserved[name]);
  }
});

test("a failed Node download leaves the running service and files untouched", async (t) => {
  const { root, error, preserved, services } = await updateNode(t, { downloadFails: true });
  assert.ok(error);
  assert.ok(!services.includes("stop "));
  assert.equal(await readFile(join(root, "raylink-node.mjs"), "utf8"), preserved["raylink-node.mjs"]);
});
