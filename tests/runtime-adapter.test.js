import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalSingBoxAdapter } from "../server/singbox/local-adapter.js";

test("local adapter validates before atomically replacing the active config", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-"));
  const fakeBinary = join(dataDir, "fake-sing-box");
  await writeFile(fakeBinary, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("sing-box version 1.13.12");
  process.exit(0);
}
if (args[0] !== "check" || args[1] !== "-c") process.exit(2);
const config = JSON.parse(fs.readFileSync(args[2], "utf8"));
if (config.reject) {
  console.error("invalid config");
  process.exit(1);
}
console.log("configuration is valid");
`);
  await chmod(fakeBinary, 0o755);

  const adapter = new LocalSingBoxAdapter({
    dataDir,
    binaryPath: fakeBinary,
    mode: "dry-run"
  });
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const first = await adapter.publish({
    version: "v1",
    checksum: "first",
    configText: "{\"inbounds\":[]}\n"
  });
  assert.equal(first.mode, "dry-run");
  assert.equal(first.runtimeVersion, "1.13.12");

  const activePath = join(dataDir, "sing-box", "config.json");
  assert.equal(await readFile(activePath, "utf8"), "{\"inbounds\":[]}\n");

  await assert.rejects(
    () => adapter.publish({
      version: "v2",
      checksum: "second",
      configText: "{\"reject\":true}\n"
    }),
    /invalid config/
  );
  assert.equal(await readFile(activePath, "utf8"), "{\"inbounds\":[]}\n");
});

test("first systemd publish failure does not leave an unstarted config active", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-failed-first-"));
  const fakeBinary = join(dataDir, "fake-sing-box");
  await writeFile(fakeBinary, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("sing-box version 1.13.12");
  process.exit(0);
}
process.exit(args[0] === "check" ? 0 : 2);
`);
  await chmod(fakeBinary, 0o755);
  const adapter = new LocalSingBoxAdapter({
    dataDir,
    binaryPath: fakeBinary,
    mode: "systemd"
  });
  adapter.restartSystemd = async () => {
    throw new Error("restart failed");
  };
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  await assert.rejects(
    () => adapter.publish({
      version: "v1",
      checksum: "first",
      configText: "{\"inbounds\":[]}\n"
    }),
    /restart failed/
  );
  await assert.rejects(() => readFile(join(dataDir, "sing-box", "config.json"), "utf8"), /ENOENT/);
});

test("first local publication stops a running candidate before reporting rollback", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-stop-first-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let running = false;
  const adapter = new LocalSingBoxAdapter({ dataDir, mode: "systemd", runner: async (command, args) => {
    if (command !== "systemctl") return { stdout: "" };
    if (args[0] === "restart") { running = true; return { stdout: "" }; }
    if (args[0] === "stop") { running = false; return { stdout: "" }; }
    if (running) throw new Error("activation status check timed out");
    throw Object.assign(new Error("inactive"), { code: 3, stdout: "inactive\n" });
  } });
  await assert.rejects(adapter.publish({ version: "first", configText: '{"inbounds":[]}' }), (error) => {
    assert.match(error.message, /activation status check timed out/);
    assert.equal(error.rolledBack, true);
    assert.equal(running, false, "the rejected candidate must no longer serve traffic");
    return true;
  });
  await assert.rejects(readFile(adapter.activePath), { code: "ENOENT" });
});

for (const failure of ["stop-failed", "still-active", "status-unavailable"]) {
  test(`first local publication reports failed rollback when ${failure}`, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-stop-failed-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    let checks = 0;
    const adapter = new LocalSingBoxAdapter({ dataDir, mode: "systemd", runner: async (command, args) => {
      if (command !== "systemctl" || args[0] === "restart") return { stdout: "" };
      if (args[0] === "stop") {
        if (failure === "stop-failed") throw new Error("stop denied");
        return { stdout: "" };
      }
      if (++checks === 1) throw new Error("activation check failed");
      if (failure === "status-unavailable") throw Object.assign(new Error("status unavailable"), { code: 1 });
      return { stdout: "active\n" };
    } });
    await assert.rejects(adapter.publish({ version: "first", configText: '{"inbounds":[]}' }), (error) => {
      assert.equal(error.message, "activation check failed");
      assert.equal(error.rolledBack, false);
      assert.match(error.rollbackError, /stop denied|active|status unavailable/);
      return true;
    });
  });
}

test("local publication preserves both activation and rollback errors", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-rollback-failed-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const fakeBinary = join(dataDir, "fake-sing-box");
  await writeFile(fakeBinary, `#!${process.execPath}\nprocess.exit(0);\n`);
  await chmod(fakeBinary, 0o755);
  const staged = new LocalSingBoxAdapter({ dataDir, binaryPath: fakeBinary });
  await staged.publish({ version: "v1", configText: '{"version":"previous"}\n' });
  let restarts = 0;
  const adapter = new LocalSingBoxAdapter({
    dataDir, binaryPath: fakeBinary, mode: "systemd",
    runner: async (command, args) => {
      if (command === "systemctl" && args[0] === "restart") {
        throw new Error(++restarts === 1 ? "candidate failed" : "previous failed");
      }
      return { stdout: "active\n", stderr: "" };
    }
  });
  await assert.rejects(adapter.publish({ version: "v2", configText: '{"version":"candidate"}\n' }), (error) => {
    assert.equal(error.message, "candidate failed");
    assert.equal(error.rolledBack, false);
    assert.equal(error.rollbackError, "previous failed");
    return true;
  });
  assert.equal(await readFile(join(dataDir, "sing-box", "config.json"), "utf8"), '{"version":"previous"}\n');
  assert.equal(restarts, 2);
});

test("version probe failure after activation does not fail the deployment", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-version-probe-"));
  const fakeBinary = join(dataDir, "fake-sing-box");
  await writeFile(fakeBinary, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "version") process.exit(1);
process.exit(args[0] === "check" ? 0 : 2);
`);
  await chmod(fakeBinary, 0o755);
  const adapter = new LocalSingBoxAdapter({
    dataDir,
    binaryPath: fakeBinary,
    mode: "dry-run"
  });
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const result = await adapter.publish({
    version: "v1",
    checksum: "first",
    configText: "{\"inbounds\":[]}\n"
  });
  assert.equal(result.runtimeVersion, null);
  assert.equal(
    await readFile(join(dataDir, "sing-box", "config.json"), "utf8"),
    "{\"inbounds\":[]}\n"
  );
});

test("local adapter verifies UDP and TCP protocols through sing-box tools fetch", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-protocol-probe-"));
  const fakeBinary = join(dataDir, "fake-sing-box");
  const probeRecord = join(dataDir, "probe.json");
  await writeFile(fakeBinary, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("sing-box version 1.13.14");
  process.exit(0);
}
if (args[0] === "check") process.exit(0);
if (args[0] === "tools" && args[1] === "fetch") {
  const configPath = args[args.indexOf("-c") + 1];
  fs.writeFileSync(${JSON.stringify(probeRecord)}, fs.readFileSync(configPath));
  process.exit(0);
}
process.exit(2);
`);
  await chmod(fakeBinary, 0o755);
  const adapter = new LocalSingBoxAdapter({
    dataDir,
    binaryPath: fakeBinary,
    mode: "systemd"
  });
  adapter.restartSystemd = async () => {};
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await adapter.publish({
    version: "v1",
    checksum: "first",
    configText: JSON.stringify({
      inbounds: [{
        type: "tuic",
        tag: "raylink-tuic",
        listen: "::",
        listen_port: 8447,
        users: [{
          name: "probe@example.com",
          uuid: "d5d29d63-1dad-4e45-9d0b-d4a012b71015",
          password: "probe-password"
        }],
        tls: {
          enabled: true,
          server_name: "node.example.com",
          certificate_path: "/tmp/certificate.pem",
          key_path: "/tmp/private-key.pem"
        }
      }]
    })
  });

  const result = await adapter.probeProtocol({
    type: "tuic",
    address: "node.example.com",
    port: 8447
  });

  assert.equal(result.reachable, true);
  assert.equal(result.protocol, "tuic");
  assert.equal(Number.isInteger(result.latencyMs), true);
  assert.ok(result.latencyMs >= 0);
  assert.deepEqual(JSON.parse(await readFile(probeRecord, "utf8")).outbounds, [{
    type: "tuic",
    tag: "raylink-probe",
    server: "node.example.com",
    server_port: 8447,
    uuid: "d5d29d63-1dad-4e45-9d0b-d4a012b71015",
    password: "probe-password",
    congestion_control: "bbr",
    tls: {
      enabled: true,
      server_name: "node.example.com"
    }
  }]);

  await adapter.publish({
    version: "v2",
    checksum: "second",
    configText: JSON.stringify({
      inbounds: [{
        type: "vless",
        tag: "raylink-vless",
        listen: "::",
        listen_port: 8444,
        users: [{
          name: "probe@example.com",
          uuid: "d5d29d63-1dad-4e45-9d0b-d4a012b71015"
        }],
        tls: {
          enabled: true,
          server_name: "node.example.com",
          certificate_path: "/tmp/certificate.pem",
          key_path: "/tmp/private-key.pem"
        }
      }]
    })
  });
  const tcpResult = await adapter.probeProtocol({
    type: "vless",
    address: "node.example.com",
    port: 8444
  });
  assert.equal(tcpResult.reachable, true);
  assert.deepEqual(JSON.parse(await readFile(probeRecord, "utf8")).outbounds, [{
    type: "vless",
    tag: "raylink-probe",
    server: "node.example.com",
    server_port: 8444,
    uuid: "d5d29d63-1dad-4e45-9d0b-d4a012b71015",
    tls: {
      enabled: true,
      server_name: "node.example.com"
    }
  }]);
});
