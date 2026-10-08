import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { NodeRuntimeAdapter } from "../web/node/raylink-node.mjs";
import { generateNodeEncryptionKeypair, sealNodeSecret } from "../server/node-secrets.js";

const execFile = promisify(execFileCallback);

async function generateCertificate(directory, name = "raylink-trojan") {
  await mkdir(directory, { recursive: true });
  const certificatePath = join(directory, `${name}.certificate.pem`);
  const keyPath = join(directory, `${name}.private-key.pem`);
  await execFile("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certificatePath, "-subj", "/CN=node.example.test"]);
  return { certificatePath, keyPath };
}

function tlsTask(task, paths) {
  const configText = JSON.stringify({ inbounds: [{ type: "trojan", listen: "127.0.0.1", listen_port: 24443,
    users: [{ name: "test-user", password: "fixture-password" }], tls: {
      enabled: true, server_name: "node.example.test", certificate_path: paths.certificatePath, key_path: paths.keyPath
    } }], outbounds: [{ type: "direct" }] }) + "\n";
  return { ...task, configText, checksum: createHash("sha256").update(configText).digest("hex") };
}

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-node-noop-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let restarts = 0, instance = 0, running = true, knownInstance = true;
  const runner = async (command, args) => {
    if (command !== "systemctl") return { stdout: args[0] === "version" ? "sing-box version 1.14.2\n" : "" };
    if (args[0] === "restart") { restarts++; instance++; running = true; }
    if (args[0] === "show") return { stdout: knownInstance ? instance.toString(16).padStart(32, "0") + "\n" : "\n" };
    return { stdout: running ? "active\n" : "inactive\n" };
  };
  const options = { dataDir, runtimeMode: "systemd", commandRunner: runner };
  const adapter = new NodeRuntimeAdapter(options);
  const configText = '{"inbounds":[],"outbounds":[{"type":"direct"}]}\n';
  const task = { version: "first", configText, checksum: createHash("sha256").update(configText).digest("hex") };
  return { dataDir, options, adapter, task, restarts: () => restarts,
    stop: () => { running = false; }, replaceInstance: () => { instance++; },
    setKnownInstance: value => { knownInstance = value; } };
}

test("Node repeated publication skips restart only with persisted evidence for the live file and Runtime instance", async (t) => {
  const f = await fixture(t);
  const initial = await f.adapter.publish(f.task);
  const reopened = new NodeRuntimeAdapter(f.options);
  const repeated = await reopened.publish({ ...f.task, version: "repeated", checksum: "untrusted-payload-checksum" });
  assert.equal(f.restarts(), 1);
  assert.equal(initial.activationConfirmed, true);
  assert.equal(repeated.unchanged, true);
  assert.equal(repeated.activationConfirmed, true);
  assert.equal(await readFile(reopened.configPath, "utf8"), f.task.configText);

  f.stop();
  await reopened.publish(f.task);
  assert.equal(f.restarts(), 2, "a stopped Runtime must restart even with the same config");
  f.replaceInstance();
  await reopened.publish(f.task);
  assert.equal(f.restarts(), 3, "external process replacement invalidates old activation evidence");
  await writeFile(reopened.configPath, '{"inbounds":[],"outbounds":[]}\n');
  await reopened.publish(f.task);
  assert.equal(f.restarts(), 4, "actual file drift cannot be hidden by the task checksum");
  f.setKnownInstance(false);
  const unknown = await reopened.publish(f.task);
  assert.equal(f.restarts(), 5);
  assert.equal(unknown.activationConfirmed, false);
  await reopened.publish(f.task);
  assert.equal(f.restarts(), 6, "an unknown Runtime instance never qualifies for no-op");
});

test("same config with rotated certificate files restarts before recording the new asset fingerprint", async (t) => {
  const f = await fixture(t);
  const paths = await generateCertificate(join(f.dataDir, "certificates"));
  const task = tlsTask(f.task, paths);
  assert.equal((await f.adapter.publish(task)).activationConfirmed, true);
  assert.equal((await new NodeRuntimeAdapter(f.options).publish(task)).unchanged, true);
  await generateCertificate(join(f.dataDir, "certificates"));
  const rotated = await new NodeRuntimeAdapter(f.options).publish(task);
  assert.equal(f.restarts(), 2);
  assert.equal(rotated.unchanged, false);
  assert.equal(rotated.activationConfirmed, true);
  assert.equal((await new NodeRuntimeAdapter(f.options).publish(task)).unchanged, true);
});

test("newly installed sealed assets force a restart even when their restored bytes and config match old proof", async (t) => {
  const f = await fixture(t);
  const paths = await generateCertificate(join(f.dataDir, "tls", "releases", "fixture"));
  const task = tlsTask(f.task, paths);
  await f.adapter.publish(task);
  const certificatePem = await readFile(paths.certificatePath, "utf8");
  const privateKeyPem = await readFile(paths.keyPath, "utf8");
  await rm(paths.certificatePath);
  await rm(paths.keyPath);
  const keypair = generateNodeEncryptionKeypair();
  const sealedTlsBundle = sealNodeSecret(keypair.publicKey, { assets: [{ name: "raylink-trojan",
    targetCertificatePath: paths.certificatePath, targetKeyPath: paths.keyPath, certificatePem, privateKeyPem }] });
  const restored = await new NodeRuntimeAdapter(f.options).publish({ ...task, sealedTlsBundle }, keypair.privateKey);
  assert.equal(f.restarts(), 2);
  assert.equal(restored.unchanged, false);
  assert.equal(restored.activationConfirmed, true);
  const repeated = await new NodeRuntimeAdapter(f.options).publish({ ...task, sealedTlsBundle }, keypair.privateKey);
  assert.equal(f.restarts(), 2, "an unchanged existing bundle does not create another restart");
  assert.equal(repeated.unchanged, true);
});

test("no-op publication still opens required firewall rules and verifies the listening protocol", async (t) => {
  const f = await fixture(t);
  await f.adapter.publish(f.task);
  let firewallOpens = 0, listenerChecks = 0, protocolChecks = 0;
  const adapter = new NodeRuntimeAdapter({ ...f.options,
    firewallManager: { open: async () => { firewallOpens++; return { managed: true, rollback: async () => {} }; } },
    portVerifier: {
      assertAvailable: async () => { throw new Error("the live Runtime already owns this port"); },
      waitForListening: async () => { listenerChecks++; }
    },
    protocolProbe: { verify: async () => { protocolChecks++; return { reachable: true }; } }
  });
  const result = await adapter.publish({ ...f.task, activation: { type: "vmess", port: 24443, network: "tcp", exposure: "public" } });
  assert.equal(f.restarts(), 1);
  assert.equal(result.unchanged, true);
  assert.equal(firewallOpens, 1);
  assert.equal(listenerChecks, 1);
  assert.equal(protocolChecks, 1);
  assert.equal(result.activation.firewallManaged, true);
});

test("activation evidence write failure preserves the applied task and leaves future publications unconfirmed", async (t) => {
  const f = await fixture(t);
  await mkdir(f.adapter.activationPath);
  const first = await f.adapter.publish(f.task);
  assert.equal(first.activationConfirmed, false);
  assert.equal(first.unchanged, false);
  assert.equal(await readFile(f.adapter.configPath, "utf8"), f.task.configText);
  const reopened = new NodeRuntimeAdapter(f.options);
  assert.equal((await reopened.publish(f.task)).activationConfirmed, false);
  assert.equal(f.restarts(), 2, "failed evidence persistence cannot authorize a later no-op");
  await rm(f.adapter.activationPath, { recursive: true });
  assert.equal((await reopened.publish(f.task)).activationConfirmed, true);
  assert.equal(f.restarts(), 3);
  assert.equal((await new NodeRuntimeAdapter(f.options).publish(f.task)).unchanged, true);
  assert.equal(f.restarts(), 3);
});

test("relative TLS paths cannot authorize no-op using the Node process working directory", async (t) => {
  const f = await fixture(t);
  const configText = JSON.stringify({ inbounds: [{ tls: { certificate_path: "README.md" } }] }) + "\n";
  const task = { ...f.task, configText };
  assert.equal((await f.adapter.publish(task)).activationConfirmed, false);
  assert.equal((await new NodeRuntimeAdapter(f.options).publish(task)).unchanged, false);
  assert.equal(f.restarts(), 2, "the Runtime may resolve relative paths under another working directory");
});

test("a certificate changed during protocol verification cannot be recorded as loaded by the Runtime", async (t) => {
  const f = await fixture(t);
  const directory = join(f.dataDir, "certificates");
  const paths = await generateCertificate(directory);
  const task = tlsTask(f.task, paths);
  const adapter = new NodeRuntimeAdapter({ ...f.options,
    firewallManager: { open: async () => ({ managed: false, rollback: async () => {} }) },
    portVerifier: { assertAvailable: async () => {}, waitForListening: async () => {} },
    protocolProbe: { verify: async () => { await generateCertificate(directory); return { reachable: true }; } }
  });
  const first = await adapter.publish({ ...task, activation: { type: "trojan", port: 24443, network: "tcp", exposure: "public" } });
  assert.equal(first.activationConfirmed, false);
  assert.equal(f.restarts(), 1);
  const repaired = await new NodeRuntimeAdapter(f.options).publish(task);
  assert.equal(f.restarts(), 2, "the later certificate needs a fresh verified activation");
  assert.equal(repaired.activationConfirmed, true);
  assert.equal((await new NodeRuntimeAdapter(f.options).publish(task)).unchanged, true);
  const changedDuringNoop = await adapter.publish({ ...task, activation: { type: "trojan", port: 24443, network: "tcp", exposure: "public" } });
  assert.equal(changedDuringNoop.unchanged, true);
  assert.equal(changedDuringNoop.activationConfirmed, false, "no-op proof must also be rechecked after verification");
  assert.equal(f.restarts(), 2);
  assert.equal((await new NodeRuntimeAdapter(f.options).publish(task)).activationConfirmed, true);
  assert.equal(f.restarts(), 3);
});
