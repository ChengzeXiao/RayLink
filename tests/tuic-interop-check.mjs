import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildSingBoxConfig } from "../server/singbox/config.js";
import { buildProtocolClientConfig, defaultProtocolConfigs, normalizeProtocolConfig } from "../server/singbox/protocol-catalog.js";
import { buildSubscriptionArtifact } from "../server/subscriptions/formats.js";

const run = promisify(execFile);
const singBoxBinary = process.env.SING_BOX_BIN || "sing-box";
const mihomoBinary = process.env.MIHOMO_BIN || "mihomo";
const directory = await mkdtemp(join(tmpdir(), "raylink-tuic-interop-"));
const children = new Set();
const payload = "raylink-tuic-cross-core-payload\n".repeat(4096);
const target = createServer((_request, response) => response.end(payload));
const user = {
  email: "interop@example.com", runtimeUuid: randomUUID(), runtimePassword: randomBytes(24).toString("base64"),
  state: "active", portalStatus: "active", quotaGb: 10, usedGb: 0, expiresAt: "2099-12-31", nodeScope: ["all"]
};

async function port() {
  const listener = createTcpServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}

function sanitize(value) {
  return String(value).replaceAll(user.runtimeUuid, "[fixture-uuid]").replaceAll(user.runtimePassword, "[fixture-password]");
}

async function launch(name, binary, args, ready) {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  const state = { child, log: "", closed: new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  }) };
  children.add(state);
  const capture = (chunk) => { state.log = (state.log + chunk).slice(-32768); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", (error) => capture(error.message));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await ready(state)) return state;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await delay(50);
  }
  throw new Error(`${name} did not start: ${sanitize(state.log)}`);
}

async function stop(state) {
  if (!state) return;
  const child = state.child;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    try { await state.closed; } finally { clearTimeout(timer); }
  }
  children.delete(state);
}

async function startSingBox(name, config) {
  const path = join(directory, `${name}.json`);
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  await run(singBoxBinary, ["check", "-c", path], { timeout: 10000 });
  return launch(name, singBoxBinary, ["run", "-c", path], (state) => state.log.includes("sing-box started"));
}

async function startMihomo(outbound, socksPort) {
  // Replace the routing graph so private fixture traffic cannot accidentally
  // bypass TUIC through DIRECT; allow only the isolated self-signed certificate.
  const artifact = buildSubscriptionArtifact({ format: "mihomo", singBoxConfig: { outbounds: [outbound] } }).body;
  let proxyBlock = artifact.split("\nproxies:\n")[1]?.split("\nproxy-groups:\n")[0];
  assert.ok(proxyBlock, "Mihomo subscription must contain the TUIC proxy");
  assert.match(proxyBlock, /skip-cert-verify: false/, "Production exporter must keep certificate verification enabled");
  proxyBlock = proxyBlock.replace("skip-cert-verify: false", "skip-cert-verify: true");
  const path = join(directory, "mihomo.yaml");
  await writeFile(path, `mixed-port: ${socksPort}\nallow-lan: false\nmode: rule\nlog-level: info\ngeo-auto-update: false\nfind-process-mode: off\nproxies:\n${proxyBlock}\nrules:\n  - MATCH,${outbound.tag}\n`, { mode: 0o600 });
  await run(mihomoBinary, ["-t", "-d", directory, "-f", path], { timeout: 10000 });
  return launch("Mihomo", mihomoBinary, ["-d", directory, "-f", path], () => new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: socksPort });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  }));
}

async function transfer(socksPort) {
  return (await run("curl", ["--silent", "--show-error", "--fail", "--noproxy", "",
    "--max-time", "5", "--socks5-hostname", `127.0.0.1:${socksPort}`,
    `http://127.0.0.1:${target.address().port}/payload`], { timeout: 8000, maxBuffer: 1024 * 1024 })).stdout;
}

try {
  await chmod(directory, 0o700);
  const singBoxVersion = (await run(singBoxBinary, ["version"], { timeout: 10000 })).stdout.split("\n")[0];
  const mihomoVersion = (await run(mihomoBinary, ["-v"], { timeout: 10000 })).stdout.split("\n")[0];
  assert.match(singBoxVersion, /^sing-box version /);
  assert.match(mihomoVersion, /^Mihomo /);
  const certificatePath = join(directory, "cert.pem");
  const keyPath = join(directory, "key.pem");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certificatePath, "-subj", "/CN=node.example.com",
    "-addext", "subjectAltName=DNS:node.example.com"], { timeout: 10000 });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const profile = normalizeProtocolConfig({ ...defaultProtocolConfigs().find((entry) => entry.type === "tuic"),
    enabled: true, listen: "127.0.0.1", port: await port(),
    tls: { mode: "certificate", serverName: "node.example.com", certificatePath, keyPath } });
  const serverConfig = buildSingBoxConfig({ host: { region: "test" }, users: [user], protocols: [profile],
    masterPassword: randomBytes(16).toString("base64") });
  const generated = buildProtocolClientConfig({ profiles: [profile], server: "127.0.0.1", credential: user });
  const outbound = generated.outbounds.find((entry) => entry.type === "tuic");
  assert.ok(outbound, "TUIC client outbound must be exported");
  // The certificate is an isolated self-signed fixture. This setting remains
  // identical across all controls; no production credentials or network used.
  outbound.tls.insecure = true;
  let server;
  let client;
  try {
    server = await startSingBox("server", serverConfig);
    const socksPort = await port();
    client = await startMihomo(outbound, socksPort);
    try {
      assert.equal(await transfer(socksPort), payload, "Mihomo subscription must transfer the complete payload through TUIC");
    } catch (error) {
      throw new Error(`Mihomo TUIC transfer failed: ${sanitize(error.message)}\n${sanitize(client.log)}`, { cause: error });
    }
    process.stdout.write(`${JSON.stringify({ check: "mihomo-export", passed: true, bytes: payload.length })}\n`);
    await stop(client);
    client = null;

    const singBoxPort = await port();
    client = await startSingBox("sing-box-client", { log: { level: "info" },
      inbounds: [{ type: "socks", listen: "127.0.0.1", listen_port: singBoxPort }],
      outbounds: [outbound], route: { final: outbound.tag } });
    assert.equal(await transfer(singBoxPort), payload, "Generated sing-box client must transfer the complete payload through TUIC");
    process.stdout.write(`${JSON.stringify({ check: "sing-box-export", passed: true, bytes: payload.length })}\n`);
    await stop(client);
    client = null;
    await stop(server);
    server = null;

    // Reproduce the old server setting with the same fixture and client. This
    // proves the positive transfer used TUIC, rather than a direct-route bypass.
    const missingAlpnConfig = structuredClone(serverConfig);
    delete missingAlpnConfig.inbounds.find((entry) => entry.type === "tuic").tls.alpn;
    server = await startSingBox("server-without-alpn", missingAlpnConfig);
    const negativePort = await port();
    client = await startMihomo(outbound, negativePort);
    await assert.rejects(() => transfer(negativePort), "A server with missing ALPN must reproduce the interoperability failure");
    assert.match(client.log, /tls: server did not select an ALPN protocol|tls: no application protocol/,
      "Negative control must fail on ALPN negotiation");
    process.stdout.write(`${JSON.stringify({ check: "missing-server-alpn-rejected", passed: true })}\n`);
  } finally { await stop(client); await stop(server); }
  process.stdout.write(`${JSON.stringify({ passed: true, singBoxVersion, mihomoVersion })}\n`);
} catch (error) {
  process.stderr.write(`${sanitize(error.stack || error.message)}\n`);
  process.exitCode = 1;
} finally {
  await Promise.all([...children].map(stop));
  if (target.listening) await new Promise((resolve) => target.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
