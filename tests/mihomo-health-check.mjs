// Real-core regression: the exported subscription owns health checks once,
// honors slow usable paths, and changes exit after an actual node outage.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildSingBoxConfig } from "../server/singbox/config.js";
import { buildMultiHostProtocolClientConfig, defaultProtocolConfigs, normalizeProtocolConfig } from "../server/singbox/protocol-catalog.js";
import { buildSubscriptionArtifact } from "../server/subscriptions/formats.js";

const run = promisify(execFile);
const singBox = process.env.SING_BOX_BIN || "sing-box";
const mihomo = process.env.MIHOMO_BIN || "mihomo";
const directory = await mkdtemp(join(tmpdir(), "raylink-mihomo-health-"));
const children = new Set();
const types = ["vmess", "trojan", "vless", "anytls", "hysteria", "tuic", "hysteria2"];
const user = { email: "health-fixture@example.invalid", runtimeUuid: randomUUID(), runtimePassword: randomBytes(24).toString("base64"), state: "active", portalStatus: "active", quotaGb: 10, usedGb: 0, expiresAt: "2099-12-31", nodeScope: ["all"] };
const payload = "raylink-health-strict-tls\n".repeat(4096);
let heads = 0;
let responseDelay = 20;
const target = createServer((req, res) => {
  if (req.url === "/health") {
    heads++;
    setTimeout(() => { res.writeHead(204); res.end(); }, responseDelay);
  } else res.end(payload);
});
const clean = (text) => String(text).replaceAll(user.runtimeUuid, "[fixture-uuid]").replaceAll(user.runtimePassword, "[fixture-password]");

async function port() {
  const server = tcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}
async function waitFor(test, message, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await test()) return;
    await delay(50);
  }
  throw new Error(message);
}
async function launch(binary, args, ready) {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  const state = { child, log: "", closed: new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); }) };
  children.add(state);
  const capture = (text) => { state.log = (state.log + text).slice(-16384); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", (error) => capture(error.message));
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(clean(state.log));
    return ready(state);
  }, "Fixture core did not start");
  return state;
}
async function stop(state) {
  if (!state) return;
  if (state.child.exitCode === null && state.child.signalCode === null) {
    state.child.kill("SIGTERM");
    const timer = setTimeout(() => state.child.kill("SIGKILL"), 1500);
    try { await state.closed; } finally { clearTimeout(timer); }
  }
  children.delete(state);
}
async function transfer(socksPort) {
  return (await run("curl", ["--silent", "--show-error", "--fail", "--noproxy", "", "--max-time", "3", "--socks5-hostname", `127.0.0.1:${socksPort}`, `http://127.0.0.1:${target.address().port}/payload`], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout;
}

try {
  await chmod(directory, 0o700);
  // Missing binaries are errors: this must never become a silently skipped gate.
  const serverVersion = (await run(singBox, ["version"], { timeout: 10000 })).stdout.split("\n")[0];
  const clientVersion = (await run(mihomo, ["-v"], { timeout: 10000 })).stdout.split("\n")[0];
  const key = join(directory, "server.key");
  const cert = join(directory, "server.pem");
  const caKey = join(directory, "ca.key");
  const ca = join(directory, "ca.pem");
  const csr = join(directory, "server.csr");
  const ext = join(directory, "server.ext");
  await writeFile(ext, "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:node.fixture.invalid\n");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", caKey, "-out", ca, "-subj", "/CN=RayLink isolated health CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { timeout: 10000 });
  await run("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=node.fixture.invalid"], { timeout: 10000 });
  await run("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-days", "1", "-extfile", ext], { timeout: 10000 });
  const caPem = await readFile(ca, "utf8");
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const probeUrl = `http://127.0.0.1:${target.address().port}/health`;
  const profiles = [];
  const servers = new Map();
  async function startServer(profile) {
    const config = buildSingBoxConfig({ host: { region: "fixture" }, users: [user], protocols: [profile], masterPassword: randomBytes(16).toString("base64") });
    const path = join(directory, `${profile.type}.json`);
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    return launch(singBox, ["run", "-c", path], (state) => state.log.includes("sing-box started"));
  }
  for (const type of types) {
    const profile = normalizeProtocolConfig({ ...defaultProtocolConfigs().find((candidate) => candidate.type === type), enabled: true, listen: "127.0.0.1", port: await port(), tls: { mode: "certificate", serverName: "node.fixture.invalid", certificatePath: cert, keyPath: key } });
    profiles.push(profile);
    servers.set(type, await startServer(profile));
  }
  const generated = buildMultiHostProtocolClientConfig({ hosts: [{ id: "fixture", address: "node.fixture.invalid", protocols: profiles }], credential: user, probeUrl, routePolicy: { mode: "smart" } });
  const artifact = buildSubscriptionArtifact({ format: "mihomo-modern", singBoxConfig: generated, endpointOverrides: { "node.fixture.invalid": "127.0.0.1" } }).body;
  assert.ok(!artifact.includes("skip-cert-verify: true"), "Export must retain certificate verification");
  const names = types.map((type) => `raylink-fixture-${type}`);
  const mixed = await port();
  const controller = await port();
  const base = `http://127.0.0.1:${controller}`;
  const fixtureHeader = `external-controller: 127.0.0.1:${controller}\ntls:\n  custom-certifactes:\n    - ${JSON.stringify(caPem)}\ngeo-auto-update: false\nfind-process-mode: off\n`;
  // Warm the process CA pool before parsing QUIC outbounds. No OS trust changes.
  const bootstrap = join(directory, "bootstrap.yaml");
  await writeFile(bootstrap, fixtureHeader + "mode: global\n", { mode: 0o600 });
  const client = await launch(mihomo, ["-d", directory, "-f", bootstrap], async () => { try { return (await fetch(base + "/version")).ok; } catch { return false; } });
  const path = join(directory, "subscription.yaml");
  const config = fixtureHeader + artifact.replace(/^mixed-port:.*$/m, `mixed-port: ${mixed}`).replace(/^mode:.*$/m, "mode: global");
  async function load(text = config) {
    await writeFile(path, text, { mode: 0o600 });
    const result = await fetch(base + "/configs?force=true", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
    assert.equal(result.status, 204, clean(await result.text()));
  }
  async function proxies() { return (await (await fetch(base + "/proxies")).json()).proxies; }
  async function select(name) {
    const node = names.includes(name);
    const result = await fetch(base + "/proxies/GLOBAL", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: node ? "手动选择" : name }) });
    assert.equal(result.status, 204, await result.text());
    if (node) {
      const selected = await fetch(base + "/proxies/" + encodeURIComponent("手动选择"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      assert.equal(selected.status, 204, await selected.text());
    }
  }
  await load();
  await waitFor(async () => { const state = await proxies(); return names.every((name) => (state[name]?.extra?.[probeUrl]?.history?.length || 0) > 0); }, "startup health checks did not complete");
  console.log(JSON.stringify({ phase: "startup", heads }));
  assert.equal(heads, 14, "Seven proxies must have one unified-delay check each (two HEAD requests), rather than a separate check per group");
  for (const name of names) {
    await select(name);
    assert.equal(await transfer(mixed), payload, `${name}: strict TLS payload must arrive intact`);
  }
  console.log(JSON.stringify({ phase: "strict-tls-payload", protocols: names.length, bytes: payload.length }));

  // Test the full exported groups, not the native delay API (whose caller can
  // override the timeout and hide a too-short subscription budget).
  responseDelay = 5500;
  for (const format of ["mihomo", "mihomo-modern"]) {
    const slowArtifact = buildSubscriptionArtifact({ format, singBoxConfig: generated, endpointOverrides: { "node.fixture.invalid": "127.0.0.1" } }).body;
    const slowConfig = fixtureHeader + slowArtifact.replace(/^mixed-port:.*$/m, `mixed-port: ${mixed}`).replace(/^mode:.*$/m, "mode: global");
    heads = 0;
    await load(slowConfig);
    await delay(5300);
    const pending = await proxies();
    for (const name of names) assert.notEqual(pending[name].extra?.[probeUrl]?.alive, false, `${format}: ${name} was incorrectly killed by a short group budget`);
    await waitFor(async () => {
      const state = await proxies();
      return names.every((name) => state[name].extra?.[probeUrl]?.history?.length > 0);
    }, "Slow health checks did not finish within the 12-second budget", 8000);
    const healthy = await proxies();
    for (const name of names) {
      assert.equal(healthy[name].extra[probeUrl].alive, true, `${format}: ${name} must remain usable`);
      assert.ok(healthy[name].extra[probeUrl].history.every((entry) => entry.delay > 0), `${format}: competing checks must not write failed status`);
    }
    if (format === "mihomo-modern") assert.equal(heads, 14);
    console.log(JSON.stringify({ phase: "slow-health", format, perHeadMs: responseDelay, heads, protocols: names.length }));
  }
  responseDelay = 20;
  for (const format of ["mihomo-modern", "mihomo"]) {
    for (const profile of profiles.slice(0, 4)) {
      if (servers.get(profile.type).child.exitCode !== null || servers.get(profile.type).child.signalCode !== null) servers.set(profile.type, await startServer(profile));
    }
    const exported = buildSubscriptionArtifact({ format, singBoxConfig: generated, endpointOverrides: { "node.fixture.invalid": "127.0.0.1" } }).body;
    const failoverConfig = fixtureHeader + exported.replace(/^mixed-port:.*$/m, `mixed-port: ${mixed}`).replace(/^mode:.*$/m, "mode: global");
    await load(failoverConfig);
    await waitFor(async () => {
      const state = await proxies();
      return names.every((name) => state[name].extra?.[probeUrl]?.history?.length > 0);
    }, "Failover fixture must begin with all nodes verified healthy");
    await select("AI 稳定出口");
    const initialAi = (await proxies())["AI 稳定出口"].now;
    assert.equal(initialAi, names[0]);
    await stop(servers.get("vmess"));
    await waitFor(async () => {
      try { return await transfer(mixed) === payload && (await proxies())["AI 稳定出口"].now !== initialAi; } catch { return false; }
    }, "AI stable group did not recover after its real TCP node stopped", 15000);
    const aiAfter = (await proxies())["AI 稳定出口"].now;
    assert.ok(names.slice(1, 4).includes(aiAfter), "AI fallback must stay on an available TCP exit");
    assert.equal(await transfer(mixed), payload);
    assert.equal((await proxies())["AI 稳定出口"].now, aiAfter, "A healthy AI fallback exit must remain stable");
    for (const type of ["trojan", "vless", "anytls"]) await stop(servers.get(type));
    await select("故障回退");
    await waitFor(async () => {
      try { return await transfer(mixed) === payload && names.slice(4).includes((await proxies())["故障回退"].now); } catch { return false; }
    }, "Default fallback did not switch from failed TCP to a usable UDP protocol", 15000);
    console.log(JSON.stringify({ phase: "actual-node-outage", format, aiTcpFailover: true, tcpToUdp: true, payloadVerified: true }));
  
    // Only accelerate the fixture's timer for the recovery observation; retain
    // the production 12-second timeout. No manual delay/health API can revive it.
    await load(failoverConfig.replace(/interval: 60/g, "interval: 2"));
    await select("故障回退");
    await waitFor(async () => names.slice(4).includes((await proxies())["故障回退"].now), "Fallback did not observe the existing outage");
    servers.set("vmess", await startServer(profiles[0]));
    await waitFor(async () => {
      const state = await proxies();
      return state[names[0]].extra?.[probeUrl]?.alive === true && state["故障回退"].now === names[0];
    }, "Scheduled health checks did not restore the recovered TCP node", 8000);
    assert.equal(await transfer(mixed), payload);
    console.log(JSON.stringify({ phase: "scheduled-recovery", format, acceleratedIntervalSeconds: 2, tcpRestored: true }));
  }

  // Same trusted CA, same credentials and port: only the SNI becomes invalid.
  // An accidental skip-cert-verify regression must fail this negative control.
  await load(config.replaceAll('servername: "node.fixture.invalid"', 'servername: "wrong.fixture.invalid"').replaceAll('sni: "node.fixture.invalid"', 'sni: "wrong.fixture.invalid"'));
  await select(names[0]);
  await assert.rejects(() => transfer(mixed), "A wrong certificate hostname must never carry payload");
  assert.match(client.log, /x509:.*(?:valid for|certificate)/, "Failure must be certificate verification, not an unrelated proxy error");
  console.log(JSON.stringify({ phase: "wrong-sni", rejectedByCertificateVerification: true }));
  await stop(client);
  console.log(JSON.stringify({ serverVersion, clientVersion, passed: true }));
} catch (error) {
  process.stderr.write(clean(error.stack || error.message) + "\n");
  process.exitCode = 1;
} finally {
  await Promise.all([...children].map(stop));
  target.closeAllConnections();
  if (target.listening) await new Promise((resolve) => target.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
