import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalSingBoxAdapter } from "../server/singbox/local-adapter.js";

test("identical publication skips restart only with matching live configuration and activation evidence", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-noop-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let restarts = 0, instance = 0;
  const runner = async (command, args) => {
    if (command !== "systemctl") return { stdout: args[0] === "version" ? "sing-box version 1.14.2\n" : "" };
    if (args[0] === "restart") { restarts++; instance++; }
    return { stdout: args[0] === "show" ? instance.toString(16).padStart(32, "0") + "\n" : "active\n" };
  };
  const adapter = new LocalSingBoxAdapter({ dataDir, mode: "systemd", runner });
  const configText = '{"inbounds":[],"outbounds":[{"type":"direct"}]}\n';
  const checksum = createHash("sha256").update(configText).digest("hex");
  await adapter.publish({ version: "one", configText, checksum });
  // Evidence must survive control-plane restarts, not live only in memory.
  const reopened = new LocalSingBoxAdapter({ dataDir, mode: "systemd", runner });
  const repeated = await reopened.publish({ version: "two", configText, checksum });
  assert.equal(restarts, 1);
  assert.equal(repeated.unchanged, true);
  assert.equal((await reopened.status()).appliedChecksum, checksum);

  await writeFile(adapter.activePath, '{"inbounds":[],"outbounds":[]}\n');
  const drifted = await reopened.status();
  assert.notEqual(drifted.configChecksum, checksum);
  assert.equal(drifted.appliedChecksum, null);
  await reopened.publish({ version: "repair", configText, checksum });
  assert.equal(restarts, 2, "a matching database checksum must not hide file drift");
  instance++;
  assert.equal((await reopened.status()).appliedChecksum, null, "a different process has no confirmed activation evidence");
  await reopened.publish({ version: "confirm", configText, checksum });
  assert.equal(restarts, 3);
});

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

test("certificate activation does not confirm a file changed while protocol verification is pending", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-certificate-activation-drift-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let instance = 0, loadedConfig = null;
  const adapter = new LocalSingBoxAdapter({ dataDir, mode: "systemd", runner: async (command, args) => {
    if (command !== "systemctl") return { stdout: args[0] === "version" ? "sing-box version 1.14.2\n" : "" };
    if (args[0] === "restart") {
      instance++;
      loadedConfig = await readFile(adapter.activePath, "utf8");
    }
    return { stdout: args[0] === "show" ? instance.toString(16).padStart(32, "0") + "\n" : "active\n" };
  } });
  const config = { inbounds: [{ type: "tuic", tag: "tuic-fixture", listen: "127.0.0.1", listen_port: 12345,
    tls: { server_name: "fixture.invalid" } }] };
  const originalText = JSON.stringify(config) + "\n";
  const driftedText = JSON.stringify({ ...config, marker: "changed-during-verification" }) + "\n";
  await adapter.publish({ version: "original", configText: originalText });
  let probes = 0;
  // Use the public protocol probe boundary to reproduce an external edit
  // during asynchronous certificate verification, without opening a listener.
  adapter.probeProtocol = async () => { probes++; await writeFile(adapter.activePath, driftedText); };
  await adapter.activateCertificates({ config, certificates: [{ domain: "fixture.invalid",
    inboundTags: ["tuic-fixture"], fingerprint256: "fixture" }] });
  assert.equal(probes, 1);
  assert.equal(loadedConfig, originalText, "the process started with the original configuration");
  assert.equal(await readFile(adapter.activePath, "utf8"), driftedText);
  const status = await adapter.status();
  assert.equal(status.appliedChecksum, null, "a file read after verification cannot prove that the process loaded it");
  assert.equal(status.configurationIntegrity, "drifted");
});

test("successful restoration stays rolled back when persisting activation evidence fails", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-restoration-evidence-failure-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let restarts = 0, loadedConfig = null;
  const adapter = new LocalSingBoxAdapter({ dataDir, mode: "systemd", runner: async (command, args) => {
    if (command !== "systemctl") return { stdout: args[0] === "version" ? "sing-box version 1.14.2\n" : "" };
    if (args[0] === "restart") {
      restarts++;
      if (restarts === 2) throw new Error("candidate restart failed");
      loadedConfig = await readFile(adapter.activePath, "utf8");
    }
    return { stdout: args[0] === "show" ? restarts.toString(16).padStart(32, "0") + "\n" : "active\n" };
  } });
  const originalText = '{"inbounds":[],"marker":"previous"}\n';
  await adapter.publish({ version: "previous", configText: originalText });
  // A directory at the evidence staging path injects a real filesystem
  // failure while leaving configuration restoration and systemd available.
  await (await import("node:fs/promises")).mkdir(adapter.activationPath + ".tmp");
  await assert.rejects(adapter.publish({ version: "candidate", configText: '{"inbounds":[],"marker":"candidate"}\n' }), error => {
    assert.equal(error.message, "candidate restart failed");
    assert.equal(error.rolledBack, true, "evidence persistence is separate from restoration success");
    assert.equal(error.rollbackError, undefined);
    return true;
  });
  assert.equal(restarts, 3);
  assert.equal(loadedConfig, originalText);
  assert.equal(await readFile(adapter.activePath, "utf8"), originalText);
  const status = await adapter.status();
  assert.equal(status.state, "running");
  assert.equal(status.appliedChecksum, null, "failed evidence persistence must remain unverified");
});

test("same-path TLS certificate and key updates invalidate activation and require a restart", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-tls-inputs-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const certificatePath = join(dataDir, "certificate.pem"), keyPath = join(dataDir, "key.pem");
  await writeFile(certificatePath, "certificate-one");
  await writeFile(keyPath, "key-one");
  let restarts = 0;
  const runner = async (command, args) => {
    if (command !== "systemctl") return { stdout: args[0] === "version" ? "sing-box version 1.14.2\n" : "" };
    if (args[0] === "restart") restarts++;
    return { stdout: args[0] === "show" ? restarts.toString(16).padStart(32, "0") : "active" };
  };
  const adapter = new LocalSingBoxAdapter({ dataDir, mode: "systemd", runner });
  const configText = JSON.stringify({ inbounds: [{ type: "trojan", tls: {
    enabled: true, certificate_path: certificatePath, key_path: keyPath
  } }] });
  const checksum = createHash("sha256").update(configText).digest("hex");
  assert.equal((await adapter.publish({ version: "initial", configText, checksum })).activationConfirmed, true);
  assert.equal((await adapter.publish({ version: "unchanged", configText, checksum })).unchanged, true);
  for (const [path, value] of [[certificatePath, "certificate-two"], [keyPath, "key-two"]]) {
    await writeFile(path, value);
    assert.equal((await adapter.status()).appliedChecksum, null, "unchanged config cannot confirm changed external TLS assets");
    const result = await adapter.publish({ version: value, configText, checksum });
    assert.equal(result.unchanged, false);
    assert.equal(result.activationConfirmed, true);
    assert.equal((await adapter.status()).appliedChecksum, checksum);
  }
  assert.equal(restarts, 3);
});

test("TLS assets changed during restart cannot be recorded as loaded", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-tls-race-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const keyPath = join(dataDir, "key.pem");
  await writeFile(keyPath, "key-before-restart");
  let loadedKey;
  const adapter = new LocalSingBoxAdapter({ dataDir, mode: "systemd", runner: async (command, args) => {
    if (command !== "systemctl") return { stdout: args[0] === "version" ? "sing-box version 1.14.2" : "" };
    if (args[0] === "restart") {
      loadedKey = await readFile(keyPath, "utf8");
      await writeFile(keyPath, "key-after-restart");
    }
    return { stdout: args[0] === "show" ? "1".repeat(32) : "active" };
  } });
  const result = await adapter.publish({ version: "race", configText: JSON.stringify({ inbounds: [{ tls: { key_path: keyPath } }] }) });
  assert.equal(loadedKey, "key-before-restart");
  assert.equal(result.activationConfirmed, false);
  assert.equal((await adapter.status()).appliedChecksum, null);
});

test("certificate activation never confirms assets changed during protocol verification", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-certificate-assets-race-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const keyPath = join(dataDir, "key.pem");
  await writeFile(keyPath, "key-before-verification");
  let instance = 0;
  const adapter = new LocalSingBoxAdapter({ dataDir, mode: "systemd", runner: async (command, args) => {
    if (command !== "systemctl") return { stdout: args[0] === "version" ? "sing-box version 1.14.2" : "" };
    if (args[0] === "restart") instance++;
    return { stdout: args[0] === "show" ? instance.toString(16).padStart(32, "0") : "active" };
  } });
  const config = { inbounds: [{ type: "tuic", tag: "tuic-fixture", listen: "127.0.0.1", listen_port: 12345,
    tls: { server_name: "fixture.invalid", key_path: keyPath } }] };
  await adapter.publish({ version: "original", configText: JSON.stringify(config) });
  adapter.probeProtocol = async () => { await writeFile(keyPath, "key-after-verification"); };
  await adapter.activateCertificates({ config, certificates: [{ domain: "fixture.invalid",
    inboundTags: ["tuic-fixture"], fingerprint256: "fixture" }] });
  assert.equal((await adapter.status()).appliedChecksum, null);
});

for (const dynamicTls of [
  { inbounds: [{ tls: { acme: { domain: ["fixture.invalid"] } } }] },
  { inbounds: [{ tls: { certificate_provider: "acme-fixture" } }], certificate_providers: [{ tag: "acme-fixture", type: "acme" }] }
]) {
  test("dynamic certificate providers conservatively disable confirmed no-op publication", async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-dynamic-tls-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    let restarts = 0;
    const adapter = new LocalSingBoxAdapter({ dataDir, mode: "systemd", runner: async (command, args) => {
      if (command !== "systemctl") return { stdout: args[0] === "version" ? "sing-box version 1.14.2" : "" };
      if (args[0] === "restart") restarts++;
      return { stdout: args[0] === "show" ? restarts.toString(16).padStart(32, "0") : "active" };
    } });
    const configText = JSON.stringify(dynamicTls);
    const first = await adapter.publish({ version: "first", configText });
    assert.equal(first.activationConfirmed, true, "the configuration still has activation proof");
    assert.equal(first.tlsActivationConfirmed, false, "provider-owned TLS material is not confirmed");
    const initial = await adapter.status();
    assert.equal(initial.appliedChecksum, createHash("sha256").update(configText).digest("hex"),
      "configuration reconciliation must not repeatedly publish provider configs");
    assert.equal(initial.noOpEligible, false);
    assert.equal(initial.tlsConfigurationIntegrity, "unavailable");
    assert.equal((await adapter.publish({ version: "second", configText })).unchanged, false);
    assert.equal(restarts, 2);
    assert.equal((await adapter.status()).appliedChecksum, initial.appliedChecksum);
  });
}

test("automatic reconciliation does not repeatedly restart a provider-managed configuration", async (t) => {
  const { RayLinkStore } = await import("../server/database.js");
  const { RuntimeManager } = await import("../server/singbox/runtime-manager.js");
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-provider-reconcile-"));
  const store = new RayLinkStore({ dbPath: join(dataDir, "raylink.db"), adminUsername: "admin",
    adminPassword: "provider-fixture-password", seedDemoData: false });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  store.updateLocalRuntimeCapabilities({ version: "1.14.2", platform: "linux", tags: ["with_acme", "with_quic"] });
  store.updateHostProtocolConfig("local", "trojan", { enabled: true, tls: { mode: "acme",
    serverName: "fixture.invalid", acmeEmail: "operations@example.test", acmeDataDirectory: join(dataDir, "acme") } });
  let restarts = 0;
  const adapter = new LocalSingBoxAdapter({ dataDir, mode: "systemd", runner: async (command, args) => {
    if (command !== "systemctl") return { stdout: args[0] === "version" ? "sing-box version 1.14.2" : "" };
    if (args[0] === "restart") restarts++;
    return { stdout: args[0] === "show" ? restarts.toString(16).padStart(32, "0") : "active" };
  } });
  const manager = new RuntimeManager({ store, adapter });
  await manager.publish();
  for (let tick = 0; tick < 3; tick += 1) {
    const result = await manager.reconcile();
    assert.equal(result.changed, false);
    assert.equal(result.reason, "configuration-current");
  }
  assert.equal(restarts, 1);
  await manager.publish();
  assert.equal(restarts, 2, "explicit publication remains conservative without complete TLS proof");
});

test("mixed provider and static TLS configurations reconcile changed known assets", async (t) => {
  const { RayLinkStore } = await import("../server/database.js");
  const { RuntimeManager } = await import("../server/singbox/runtime-manager.js");
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-mixed-tls-"));
  const store = new RayLinkStore({ dbPath: join(dataDir, "raylink.db"), adminUsername: "admin",
    adminPassword: "mixed-tls-fixture-password", seedDemoData: false });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const certificatePath = join(dataDir, "certificate.pem"), keyPath = join(dataDir, "key.pem");
  await writeFile(certificatePath, "static-certificate");
  await writeFile(keyPath, "static-key-before");
  store.updateLocalRuntimeCapabilities({ version: "1.14.2", platform: "linux", tags: ["with_acme", "with_quic"] });
  store.updateHostProtocolConfig("local", "trojan", { enabled: true, tls: { mode: "acme",
    serverName: "provider.invalid", acmeEmail: "operations@example.test", acmeDataDirectory: join(dataDir, "acme") } });
  store.updateHostProtocolConfig("local", "vless", { enabled: true, tls: { mode: "certificate",
    serverName: "static.invalid", certificatePath, keyPath } });
  let restarts = 0;
  const adapter = new LocalSingBoxAdapter({ dataDir, mode: "systemd", runner: async (command, args) => {
    if (command !== "systemctl") return { stdout: args[0] === "version" ? "sing-box version 1.14.2" : "" };
    if (args[0] === "restart") restarts++;
    return { stdout: args[0] === "show" ? restarts.toString(16).padStart(32, "0") : "active" };
  } });
  const manager = new RuntimeManager({ store, adapter });
  await manager.publish();
  assert.equal((await manager.reconcile()).changed, false);
  await writeFile(keyPath, "static-key-after");
  assert.equal((await adapter.status()).appliedChecksum, null,
    "a provider must not hide drift in a different inbound's known key file");
  assert.equal((await manager.reconcile()).changed, true);
  assert.equal(restarts, 2);
  const status = await adapter.status();
  assert.equal(status.configurationIntegrity, "verified");
  assert.equal(status.noOpEligible, false, "the remaining provider still prevents a complete no-op proof");
  assert.equal((await manager.reconcile()).changed, false);
  assert.equal(restarts, 2, "reconciliation must settle after the known asset is applied");
});
