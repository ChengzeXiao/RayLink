import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:tls";
import test from "node:test";
import { promisify } from "node:util";

import { LocalTlsRenewalManager } from "../server/tls-renewal.js";
import { CaddySetupAccessManager } from "../server/setup-access.js";

const execFile = promisify(execFileCallback);
const domain = "node.example.test";

async function certificate(directory, name, days, hostname = domain) {
  const certificatePath = join(directory, `${name}.crt`);
  const keyPath = join(directory, `${name}.key`);
  await execFile("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-days", String(days), "-keyout", keyPath, "-out", certificatePath,
    "-subj", `/CN=${name}.${hostname}`, "-addext", `subjectAltName=DNS:${hostname}`], { timeout: 10_000 });
  return { certificatePath, keyPath, fingerprint256: new X509Certificate(await readFile(certificatePath)).fingerprint256 };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-renewal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeDirectory = join(directory, "runtime");
  const previous = await certificate(directory, "previous", 30);
  const renewed = await certificate(directory, "renewed", 90);
  const certificatePath = join(runtimeDirectory, "tls", `${domain}.certificate.pem`);
  const keyPath = join(runtimeDirectory, "tls", `${domain}.private-key.pem`);
  await mkdir(join(runtimeDirectory, "tls"), { recursive: true });
  await copyFile(previous.certificatePath, certificatePath);
  await copyFile(previous.keyPath, keyPath);
  const config = { inbounds: ["trojan", "vless"].map((type, index) => ({
    type, tag: `raylink-${type}`, listen: "127.0.0.1", listen_port: 9000 + index,
    tls: { enabled: true, server_name: domain, certificate_path: certificatePath, key_path: keyPath }
  })) };
  const server = createServer({ cert: await readFile(certificatePath), key: await readFile(keyPath) }, (socket) => socket.end());
  server.on("tlsClientError", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const ca = [await readFile(previous.certificatePath), await readFile(renewed.certificatePath)];
  const handshake = () => new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: server.address().port, servername: domain, ca });
    socket.setTimeout(2_000, () => socket.destroy(new Error("TLS fixture handshake timed out")));
    socket.once("secureConnect", () => { const fingerprint = socket.getPeerCertificate().fingerprint256; socket.destroy(); resolve(fingerprint); });
    socket.once("error", reject);
  });
  let activations = 0;
  const options = {
    runtimeDirectory,
    readAppliedConfig: async () => config,
    certificateProvider: async () => ({ ...renewed, managedBy: "caddy" }),
    activate: async () => {
      activations++;
      server.setSecureContext({ cert: await readFile(certificatePath), key: await readFile(keyPath) });
      await handshake();
    }
  };
  return { directory, previous, renewed, config, certificatePath, keyPath, options, handshake,
    listenerPort: server.address().port, activationCount: () => activations };
}

test("renewed Caddy certificate reaches the active TLS listener once without changing protocol configuration", async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.config);
  const manager = new LocalTlsRenewalManager(f.options);
  assert.equal(await f.handshake(), f.previous.fingerprint256);
  const result = await manager.sync();
  assert.equal(result.status, "healthy", result.errorCode);
  assert.equal(result.changed, 1);
  assert.equal(result.certificates.length, 1, "shared certificate is synchronized once per domain");
  assert.equal(await f.handshake(), f.renewed.fingerprint256);
  assert.deepEqual(f.config, before);
  assert.equal((await stat(f.keyPath)).mode & 0o777, 0o600);
  assert.equal((await stat(f.certificatePath)).mode & 0o777, 0o644);
  assert.equal((await manager.sync()).changed, 0);
  assert.equal(f.activationCount(), 1, "unchanged certificate must not reload active connections");
});

test("read-only Caddy discovery requires the RayLink site marker and chooses its renewed certificate across issuers", async (t) => {
  const f = await fixture(t);
  const caddyfilePath = join(f.directory, "Caddyfile");
  const caddyDataDirectory = join(f.directory, "caddy");
  for (const [issuer, source] of [["a-old-issuer", f.previous], ["b-current-issuer", f.renewed]]) {
    const directory = join(caddyDataDirectory, issuer, domain);
    await mkdir(directory, { recursive: true });
    await copyFile(source.certificatePath, join(directory, `${domain}.crt`));
    await copyFile(source.keyPath, join(directory, `${domain}.key`));
  }
  const manager = new CaddySetupAccessManager({
    caddyfilePath, environmentFilePath: join(f.directory, "unused.env"), initialOrigin: "https://192.0.2.1",
    caddyDataDirectory, runCommand: async () => assert.fail("discovery must not invoke Caddy or sign certificates"),
    lookup: async () => assert.fail("discovery must not depend on DNS")
  });
  await writeFile(caddyfilePath, `https://${domain} {\n respond 204\n}\n`);
  assert.equal(await manager.findNodeCertificate(domain), null);
  const marked = `# RayLink managed node certificate: ${domain}\nhttps://${domain} {\n respond 204\n}\n`;
  await writeFile(caddyfilePath, marked);
  const source = await manager.findNodeCertificate(domain);
  assert.equal(source.managedBy, "caddy");
  assert.equal(new X509Certificate(await readFile(source.certificatePath)).fingerprint256, f.renewed.fingerprint256);
  assert.equal(await readFile(caddyfilePath, "utf8"), marked);
});

test("manual and inline TLS assets are not interpreted as Caddy-managed runtime certificates", async (t) => {
  const f = await fixture(t);
  f.config.inbounds[0].tls.certificate_path = f.previous.certificatePath;
  f.config.inbounds[0].tls.key_path = f.previous.keyPath;
  f.config.inbounds[1].tls.certificate = [await readFile(f.previous.certificatePath, "utf8")];
  f.config.inbounds[1].tls.key = [await readFile(f.previous.keyPath, "utf8")];
  const before = await readFile(f.certificatePath);
  const manager = new LocalTlsRenewalManager({ ...f.options,
    certificateProvider: async () => assert.fail("manual assets must not reach the Caddy provider") });
  const result = await manager.sync();
  assert.equal(result.status, "healthy", result.errorCode);
  assert.deepEqual(result.certificates, []);
  assert.equal(f.activationCount(), 0);
  assert.deepEqual(await readFile(f.certificatePath), before);
});

for (const invalid of ["wrong-domain", "mismatched-key", "expired", "older", "malformed"]) {
  test(`rejecting a ${invalid} source keeps the previous certificate serving TLS`, async (t) => {
    const f = await fixture(t);
    let source = f.renewed;
    let clock = () => new Date();
    if (invalid === "wrong-domain") source = await certificate(f.directory, "wrong", 90, "other.example.test");
    if (invalid === "mismatched-key") source = { ...f.renewed, keyPath: f.previous.keyPath };
    if (invalid === "expired") clock = () => new Date(Date.now() + 91 * 86_400_000);
    if (invalid === "older") source = await certificate(f.directory, "older", 1);
    if (invalid === "malformed") await writeFile(f.renewed.certificatePath, "sensitive-fixture-marker-not-a-certificate");
    const certificateBefore = await readFile(f.certificatePath);
    const keyBefore = await readFile(f.keyPath);
    const manager = new LocalTlsRenewalManager({ ...f.options, clock,
      certificateProvider: async () => ({ ...source, managedBy: "caddy" }) });
    const result = await manager.sync();
    assert.equal(result.status, "error");
    assert.equal(result.errorCode, {
      "wrong-domain": "TLS_CERTIFICATE_HOST_MISMATCH", "mismatched-key": "TLS_KEY_MISMATCH",
      expired: "TLS_CERTIFICATE_INVALID_DATE", older: "TLS_SOURCE_OLDER", malformed: "TLS_RENEWAL_FAILED"
    }[invalid]);
    assert.equal(await f.handshake(), f.previous.fingerprint256);
    assert.deepEqual(await readFile(f.certificatePath), certificateBefore);
    assert.deepEqual(await readFile(f.keyPath), keyBefore);
    assert.equal(f.activationCount(), 0);
    assert.doesNotMatch(JSON.stringify(manager.status()), /sensitive-fixture-marker|BEGIN|private-key|\.crt|\.key/);
  });
}

test("failure after loading a renewed certificate restores the original pair and its live TLS fingerprint", async (t) => {
  const f = await fixture(t);
  const phases = [];
  const manager = new LocalTlsRenewalManager({ ...f.options,
    activate: async (input) => {
      phases.push(input.phase);
      await f.options.activate(input);
      assert.equal(await f.handshake(), input.domains[0].fingerprint256);
      if (input.phase === "apply") throw new Error("sensitive-fixture-reload-error");
    }
  });
  const result = await manager.sync();
  assert.equal(result.status, "error");
  assert.equal(result.changed, 0);
  assert.equal(result.lastUpdatedAt, null);
  assert.deepEqual(phases, ["apply", "rollback"]);
  assert.equal(await f.handshake(), f.previous.fingerprint256);
  assert.equal(new X509Certificate(await readFile(f.certificatePath)).fingerprint256, f.previous.fingerprint256);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-fixture-reload-error/);
});

test("failed rollback activation is explicitly reported without claiming the old certificate is serving", async (t) => {
  const f = await fixture(t);
  const manager = new LocalTlsRenewalManager({ ...f.options,
    activate: async () => { throw new Error("sensitive-fixture-service-failure"); }
  });
  const result = await manager.sync();
  assert.equal(result.errorCode, "TLS_RENEWAL_ROLLBACK_FAILED");
  assert.equal(result.certificates[0].errorCode, "TLS_RENEWAL_ROLLBACK_FAILED");
  assert.equal(result.status, "error");
  assert.equal(result.changed, 0);
  assert.doesNotMatch(JSON.stringify(result), /sensitive-fixture-service-failure/);
});

test("systemd certificate activation restarts once and verifies only managed listeners sharing that domain", async (t) => {
  const f = await fixture(t);
  for (const inbound of f.config.inbounds) inbound.listen_port = f.listenerPort;
  f.config.inbounds.push({ type: "trojan", tag: "manual-trojan", listen: "127.0.0.1", listen_port: 1,
    tls: { enabled: true, server_name: domain, certificate_path: f.previous.certificatePath, key_path: f.previous.keyPath }
  });
  await mkdir(join(f.directory, "sing-box"), { recursive: true });
  await writeFile(join(f.directory, "sing-box", "config.json"), JSON.stringify(f.config));
  const adapterUrl = new URL("../server/singbox/local-adapter.js", import.meta.url).href;
  const script = `
    import { LocalSingBoxAdapter } from ${JSON.stringify(adapterUrl)};
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const { config, certificates } = JSON.parse(input);
    const operations = [];
    const adapter = new LocalSingBoxAdapter({ dataDir: process.env.FIXTURE_DATA_DIR, mode: "systemd",
      runner: async (command, args) => { operations.push([command, ...args]); return { stdout: "active\\n" }; }
    });
    await adapter.activateCertificates({ config, certificates });
    console.log(JSON.stringify({ restarts: operations.filter((entry) => entry[0] === "systemctl" && entry[1] === "restart").length }));
  `;
  const manager = new LocalTlsRenewalManager({ ...f.options, activate: async (input) => {
    await f.options.activate(input);
    const child = execFileCallback(process.execPath, ["--input-type=module", "-e", script], {
      timeout: 3_000, env: { ...process.env, NODE_EXTRA_CA_CERTS: f.renewed.certificatePath, FIXTURE_DATA_DIR: f.directory }
    });
    const output = new Promise((resolve, reject) => {
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve(stdout) : reject(new Error(`TLS verifier failed: ${signal || code}`)));
    });
    child.stdin.end(JSON.stringify({ config: f.config, certificates: input.domains }));
    assert.equal(JSON.parse(await output).restarts, 1);
  } });
  const result = await manager.sync();
  assert.equal(result.status, "healthy", result.errorCode);
  assert.equal(await f.handshake(), f.renewed.fingerprint256);
});

test("concurrent renewal requests share one activation and return detached public status", async (t) => {
  const f = await fixture(t);
  const manager = new LocalTlsRenewalManager(f.options);
  const results = await Promise.all(Array.from({ length: 8 }, () => manager.sync()));
  assert.ok(results.every((result) => result.status === "healthy"));
  assert.equal(f.activationCount(), 1);
  assert.equal(await f.handshake(), f.renewed.fingerprint256);
  const snapshot = manager.status();
  snapshot.certificates[0].fingerprint256 = "edited-by-caller";
  assert.equal(manager.status().certificates[0].fingerprint256, f.renewed.fingerprint256);
});

test("renewal warns before expiry and catches up after downtime without resetting protocol configuration", async (t) => {
  const f = await fixture(t);
  let source = f.previous;
  let now = Date.now();
  const manager = new LocalTlsRenewalManager({ ...f.options, clock: () => new Date(now),
    certificateProvider: async () => ({ ...source, managedBy: "caddy" }) });
  const warning = await manager.sync();
  assert.equal(warning.status, "warning");
  assert.equal(warning.certificates[0].status, "expiring");
  assert.equal(f.activationCount(), 0);
  now += 31 * 86_400_000;
  source = f.renewed;
  const caughtUp = await manager.sync();
  assert.equal(caughtUp.status, "healthy", caughtUp.errorCode);
  assert.equal(await f.handshake(), f.renewed.fingerprint256);
});

test("managed paths that are symlinks are never overwritten", async (t) => {
  const f = await fixture(t);
  await unlink(f.keyPath);
  await symlink(f.previous.keyPath, f.keyPath);
  const before = await readFile(f.previous.keyPath);
  const result = await new LocalTlsRenewalManager(f.options).sync();
  assert.equal(result.errorCode, "TLS_MANAGED_ASSET_UNSAFE");
  assert.deepEqual(await readFile(f.previous.keyPath), before);
  assert.equal(f.activationCount(), 0);
});

test("an unchanged managed key has private permissions repaired without reloading connections", async (t) => {
  const f = await fixture(t);
  await chmod(f.keyPath, 0o644);
  await chmod(join(f.options.runtimeDirectory, "tls"), 0o755);
  const manager = new LocalTlsRenewalManager({ ...f.options,
    certificateProvider: async () => ({ ...f.previous, managedBy: "caddy" }) });
  assert.equal((await manager.sync()).changed, 0);
  assert.equal((await stat(f.keyPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.options.runtimeDirectory, "tls"))).mode & 0o777, 0o700);
  assert.equal(f.activationCount(), 0);
});
