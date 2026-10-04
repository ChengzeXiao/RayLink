// Real-core WSS regression. All listeners and traffic stay on loopback; no AI
// account, public proxy, system trust-store change, or external website is used.
// SING_BOX_BIN=... MIHOMO_BIN=... node tests/ai-websocket-check.mjs --idle-ms=70000
// --negative-control intentionally severs the first stream and must exit nonzero.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { connect, createServer as createTcpServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildSingBoxConfig } from "../server/singbox/config.js";
import { buildMultiHostProtocolClientConfig, defaultProtocolConfigs, normalizeProtocolConfig } from "../server/singbox/protocol-catalog.js";
import { buildSubscriptionArtifact } from "../server/subscriptions/formats.js";

const run = promisify(execFile);
const controllerFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
const singBox = process.env.SING_BOX_BIN || "sing-box";
const singBoxClient = process.env.SING_BOX_CLIENT_BIN || singBox;
const mihomo = process.env.MIHOMO_BIN || "mihomo";
const idleMs = Number(process.argv.find((value) => value.startsWith("--idle-ms="))?.split("=")[1] || 1000);
assert.ok(Number.isInteger(idleMs) && idleMs >= 100 && idleMs <= 180000, "idle-ms must be between 100 and 180000");
const negativeControl = process.argv.includes("--negative-control");
const types = ["shadowsocks", "vmess", "trojan", "vless", "anytls", "hysteria", "tuic", "hysteria2", "naive"];
const directory = await mkdtemp(join(tmpdir(), "raylink-ai-websocket-"));
const children = new Set();
const sockets = new Set();
const sessions = [];
const outcomes = [];
const idleController = new AbortController();
const loopbackInterface = Object.entries(networkInterfaces()).find(([, addresses]) => addresses.some((address) => address.address === "127.0.0.1"))?.[0];
assert.ok(loopbackInterface, "A loopback interface is required");
const fixtureErrors = [];
const reservedPorts = new Set();
const user = { email: "websocket-fixture@example.invalid", runtimeUuid: randomUUID(), runtimePassword: randomBytes(16).toString("base64"), state: "active", portalStatus: "active", quotaGb: 10, usedGb: 0, expiresAt: "2099-12-31", nodeScope: ["all"] };
const masterPassword = randomBytes(16).toString("base64");
const largePayload = randomBytes(256 * 1024);
const websocketAccept = (key) => createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
const clean = (value) => String(value).replaceAll(user.runtimeUuid, "[fixture-uuid]").replaceAll(user.runtimePassword, "[fixture-password]").replaceAll(masterPassword, "[fixture-master]");
let target;

async function port() {
  for (;;) {
    const listener = createTcpServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const value = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    if (!reservedPorts.has(value)) { reservedPorts.add(value); return value; }
  }
}
async function launch(name, binary, args, ready) {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  const state = { name, child, log: "", closed: new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); }) };
  children.add(state);
  const capture = (chunk) => { state.log = (state.log + chunk).slice(-16384); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", (error) => capture(error.message));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (await ready(state)) return state;
    await delay(50);
  }
  throw new Error(`${name} did not start: ${clean(state.log)}`);
}
async function stop(state) {
  if (state.child.exitCode === null && state.child.signalCode === null) {
    state.child.kill("SIGTERM");
    const timer = setTimeout(() => state.child.kill("SIGKILL"), 1500);
    try { await state.closed; } finally { clearTimeout(timer); }
  }
  children.delete(state);
}
async function startSingBox(name, config, binary = singBox) {
  const path = join(directory, `${name}.json`);
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  await run(binary, ["check", "-c", path], { timeout: 10000 });
  return launch(name, binary, ["run", "-c", path], (state) => state.log.includes("sing-box started"));
}
function track(socket) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  return socket;
}

// Small RFC 6455 fixture codec: masking, all three payload lengths, control
// frames, and binary data. Reject extensions/fragmentation instead of hiding a
// malformed Upgrade or frame behind an echo-only success.
function encodeFrame(opcode, payload, masked = false) {
  const bytes = Buffer.from(payload);
  const lengthBytes = bytes.length < 126 ? 0 : bytes.length <= 65535 ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + (masked ? 4 : 0));
  header[0] = 0x80 | opcode;
  header[1] = (masked ? 0x80 : 0) | (lengthBytes === 0 ? bytes.length : lengthBytes === 2 ? 126 : 127);
  if (lengthBytes === 2) header.writeUInt16BE(bytes.length, 2);
  if (lengthBytes === 8) header.writeBigUInt64BE(BigInt(bytes.length), 2);
  if (!masked) return Buffer.concat([header, bytes]);
  const mask = randomBytes(4);
  mask.copy(header, 2 + lengthBytes);
  const body = Buffer.from(bytes);
  for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];
  return Buffer.concat([header, body]);
}
function frameDecoder(expectMasked, onFrame) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      assert.equal(pending[0] & 0xf0, 0x80, "Frame must be final and uncompressed");
      assert.equal(Boolean(pending[1] & 0x80), expectMasked, "Incorrect WebSocket masking direction");
      const opcode = pending[0] & 15;
      let length = pending[1] & 127;
      let offset = 2;
      if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
      else if (length === 127) {
        if (pending.length < 10) return;
        const longLength = pending.readBigUInt64BE(2);
        assert.ok(longLength <= 1024n * 1024n, "Unexpectedly large fixture WebSocket frame");
        length = Number(longLength); offset = 10;
      }
      if (opcode >= 8) assert.ok(length <= 125, "Control frames must fit 125 bytes");
      const end = offset + (expectMasked ? 4 : 0) + length;
      if (pending.length < end) return;
      const payload = Buffer.from(pending.subarray(offset + (expectMasked ? 4 : 0), end));
      if (expectMasked) for (let index = 0; index < payload.length; index++) payload[index] ^= pending[offset + index % 4];
      pending = pending.subarray(end);
      onFrame({ opcode, payload });
    }
  };
}
function readHeaders(socket, label) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error(`${label}: HTTP header timeout`)), 10000);
    function finish(error, result) {
      clearTimeout(timer); socket.off("data", receive); socket.off("error", fail); socket.off("end", ended); socket.off("close", ended);
      if (error) reject(error); else resolve(result);
    }
    function fail(error) { finish(error); }
    function ended() { finish(new Error(`${label}: stream ended during HTTP headers`)); }
    function receive(chunk) {
      data = Buffer.concat([data, chunk]);
      const index = data.indexOf("\r\n\r\n");
      if (index >= 0) { socket.pause(); finish(null, { header: data.subarray(0, index).toString("ascii"), rest: data.subarray(index + 4) }); }
      else if (data.length > 16384) finish(new Error(`${label}: oversized HTTP headers`));
    }
    socket.on("data", receive); socket.once("error", fail); socket.once("end", ended); socket.once("close", ended);
    socket.resume();
  });
}
async function connectWebSocket(mixed, path, ca) {
  const raw = track(connect({ host: "127.0.0.1", port: mixed }));
  raw.on("error", () => {});
  raw.setTimeout(10000, () => raw.destroy(new Error("Proxy CONNECT timeout")));
  const connected = readHeaders(raw, "proxy CONNECT");
  raw.write(`CONNECT 127.0.0.1:${target.address().port} HTTP/1.1\r\nHost: 127.0.0.1:${target.address().port}\r\n\r\n`);
  const tunnel = await connected;
  assert.match(tunnel.header, /^HTTP\/1\.[01] 200\b/);
  assert.equal(tunnel.rest.length, 0, "CONNECT must not inject payload");
  raw.setTimeout(0);
  const secure = track(connectTls({ socket: raw, servername: "stream.fixture.invalid", ca, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] }));
  secure.on("error", () => {});
  secure.setTimeout(10000, () => secure.destroy(new Error("Target TLS timeout")));
  raw.resume();
  await once(secure, "secureConnect");
  assert.equal(secure.authorized, true, "Target certificate must be verified");
  secure.setTimeout(0);
  const key = randomBytes(16).toString("base64");
  const upgrade = readHeaders(secure, "WebSocket Upgrade");
  secure.write(`GET ${path} HTTP/1.1\r\nHost: stream.fixture.invalid\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const received = await upgrade;
  assert.match(received.header, /^HTTP\/1\.1 101\b/, "Target must accept a real WebSocket Upgrade");
  const headers = Object.fromEntries(received.header.split("\r\n").slice(1).map((line) => { const at = line.indexOf(":"); return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()]; }));
  assert.equal(headers["sec-websocket-accept"], websocketAccept(key));
  assert.equal(headers.upgrade?.toLowerCase(), "websocket");
  const frames = [];
  let waiting;
  let failure;
  const fail = (error) => { failure ||= error; if (waiting) { const pending = waiting; waiting = null; clearTimeout(pending.timer); pending.reject(failure); } };
  const decode = frameDecoder(false, (frame) => {
    if (waiting) { const pending = waiting; waiting = null; clearTimeout(pending.timer); pending.resolve(frame); }
    else frames.push(frame);
  });
  secure.on("data", (chunk) => { try { decode(chunk); } catch (error) { fail(error); secure.destroy(); } });
  secure.on("error", fail);
  secure.on("end", () => fail(new Error("WebSocket stream ended before expected frame")));
  secure.on("close", () => fail(new Error("WebSocket stream closed before expected frame")));
  decode(received.rest);
  secure.resume();
  const session = {
    secure,
    send(opcode, payload) { if (failure) throw failure; secure.write(encodeFrame(opcode, payload, true)); },
    next(timeout = 10000) {
      if (frames.length) return Promise.resolve(frames.shift());
      if (failure) return Promise.reject(failure);
      assert.ok(!waiting, "Only one pending frame read is supported");
      return new Promise((resolve, reject) => { waiting = { resolve, reject, timer: setTimeout(() => { waiting = null; reject(new Error("WebSocket frame timeout")); }, timeout) }; });
    },
    assertOpen() { if (failure) throw failure; assert.equal(secure.destroyed, false); },
    close() { secure.destroy(); }
  };
  sessions.push(session);
  return session;
}
async function expectFrame(session, opcode, payload) {
  const frame = await session.next();
  assert.equal(frame.opcode, opcode, "Unexpected WebSocket opcode");
  assert.deepEqual(frame.payload, Buffer.from(payload), "WebSocket payload must arrive intact");
}
async function exercise(session, type) {
  await expectFrame(session, 1, "server-ready");
  session.send(1, `request:${type}`);
  await expectFrame(session, 1, `request:${type}`);
  // This frame uses RFC 6455's 64-bit length encoding; both upload and download
  // must survive the protocol transport without truncation or conversion.
  session.send(2, largePayload);
  await expectFrame(session, 2, largePayload);
  session.send(9, "before-idle");
  await expectFrame(session, 10, "before-idle");
  const before = Date.now();
  await delay(idleMs, undefined, { signal: idleController.signal }); // Deliberately no application heartbeat during this gap.
  session.assertOpen();
  session.send(1, "after-idle");
  await expectFrame(session, 1, "after-idle");
  session.send(9, "after-idle-ping");
  await expectFrame(session, 10, "after-idle-ping");
  const close = Buffer.from([0x03, 0xe8]); // Normal close 1000.
  session.send(8, close);
  await expectFrame(session, 8, close);
  session.close();
  const result = { protocol: type, client: type === "naive" ? "sing-box" : "mihomo", upgrade: 101, tlsVerified: true, binaryBytesEachWay: largePayload.length, requestedIdleMs: idleMs, observedIdleMs: Date.now() - before, bidirectional: true, normalClose: true };
  console.log(JSON.stringify(result));
  return result;
}

try {
  await chmod(directory, 0o700);
  const serverVersion = (await run(singBox, ["version"], { timeout: 10000 })).stdout.split("\n")[0];
  const clientVersion = (await run(mihomo, ["-v"], { timeout: 10000 })).stdout.split("\n")[0];
  const naiveClientVersion = singBoxClient === singBox ? serverVersion : (await run(singBoxClient, ["version"], { timeout: 10000 })).stdout.split("\n")[0];
  assert.match(serverVersion, /^sing-box version 1\.14\.2\b/, "Use the deployed Runtime version");
  assert.match(clientVersion, /^Mihomo /);
  assert.match(naiveClientVersion, /^sing-box version 1\.14\.2\b/, "Use the supported Naive client version");
  const key = join(directory, "server.key");
  const cert = join(directory, "server.pem");
  const caKey = join(directory, "ca.key");
  const ca = join(directory, "ca.pem");
  const csr = join(directory, "server.csr");
  const ext = join(directory, "server.ext");
  await writeFile(ext, "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:node.fixture.invalid,DNS:stream.fixture.invalid,IP:127.0.0.1\n", { mode: 0o600 });
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", caKey, "-out", ca, "-subj", "/CN=RayLink isolated WebSocket CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { timeout: 10000 });
  await run("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", "/CN=node.fixture.invalid"], { timeout: 10000 });
  await run("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-days", "1", "-extfile", ext], { timeout: 10000 });
  const caPem = await readFile(ca, "utf8");
  target = createServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => { response.writeHead(204); response.end(); });
  target.on("connection", track);
  target.on("upgrade", (request, socket, head) => {
    track(socket);
    socket.on("error", () => {});
    const key = request.headers["sec-websocket-key"];
    if (!key || request.headers["sec-websocket-version"] !== "13") { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`);
    socket.write(encodeFrame(1, "server-ready"));
    const decode = frameDecoder(true, ({ opcode, payload }) => {
      if ([1, 2].includes(opcode)) socket.write(encodeFrame(opcode, payload));
      else if (opcode === 9) socket.write(encodeFrame(10, payload));
      else if (opcode === 8) socket.end(encodeFrame(8, payload));
      else throw new Error(`Unexpected client opcode ${opcode}`);
    });
    socket.on("data", (chunk) => { try { decode(chunk); } catch (error) { fixtureErrors.push(error); socket.destroy(); } });
    if (head.length) decode(head);
    if (request.url === "/interrupt") {
      const timer = setTimeout(() => socket.destroy(), Math.min(100, Math.floor(idleMs / 2)));
      socket.once("close", () => clearTimeout(timer));
    }
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  reservedPorts.add(target.address().port);
  const profiles = [];
  for (const type of types) profiles.push(normalizeProtocolConfig({ ...defaultProtocolConfigs().find((profile) => profile.type === type), enabled: true, listen: "127.0.0.1", port: await port(), tls: type === "shadowsocks" ? { mode: "none" } : { mode: "certificate", serverName: "node.fixture.invalid", certificatePath: cert, keyPath: key } }));
  await startSingBox("server", buildSingBoxConfig({ host: { region: "fixture", runtimeVersion: "1.14.2" }, users: [user], protocols: profiles, masterPassword }));
  const generated = buildMultiHostProtocolClientConfig({ hosts: [{ id: "fixture", address: "127.0.0.1", protocols: profiles }], credential: { ...user, serverPassword: masterPassword }, probeUrl: `https://127.0.0.1:${target.address().port}/health`, routePolicy: { mode: "global-proxy" } });
  const artifact = buildSubscriptionArtifact({ format: "mihomo-modern", singBoxConfig: generated, routePolicy: { mode: "global-proxy" } }).body;
  assert.ok(!artifact.includes("skip-cert-verify: true"), "Exported node TLS verification must remain enabled");
  const mixed = await port();
  const controller = await port();
  const base = `http://127.0.0.1:${controller}`;
  const header = `interface-name: ${loopbackInterface}\nexternal-controller: 127.0.0.1:${controller}\ntls:\n  custom-certifactes:\n    - ${JSON.stringify(caPem)}\ngeo-auto-update: false\nfind-process-mode: off\n`;
  const bootstrap = join(directory, "bootstrap.yaml");
  await writeFile(bootstrap, header + "mode: global\n", { mode: 0o600 });
  // Initialize Mihomo's custom CA pool before it creates QUIC proxy clients.
  await launch("mihomo", mihomo, ["-d", directory, "-f", bootstrap], async () => { try { return (await controllerFetch(base + "/version")).ok; } catch { return false; } });
  const configPath = join(directory, "subscription.yaml");
  // Health endpoints do not determine this forced-protocol transfer verdict.
  const config = header + artifact.replace(/^mixed-port:.*$/m, `mixed-port: ${mixed}`).replace(/^mode:.*$/m, "mode: global");
  await writeFile(configPath, config, { mode: 0o600 });
  const loaded = await controllerFetch(base + "/configs?force=true", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: configPath }) });
  assert.equal(loaded.status, 204, clean(await loaded.text()));
  async function select(group, name) {
    const response = await controllerFetch(base + "/proxies/" + encodeURIComponent(group), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    assert.equal(response.status, 204, clean(await response.text()));
  }
  await select("GLOBAL", "手动选择");
  for (const type of types.filter((type) => type !== "naive")) {
    const name = `raylink-fixture-${type}`;
    await select("手动选择", name);
    const session = await connectWebSocket(mixed, negativeControl && type === types[0] ? "/interrupt" : "/echo", caPem);
    const active = await (await controllerFetch(base + "/connections")).json();
    assert.ok(active.connections.some((connection) => connection.chains?.includes(name)), `${type}: actual connection must traverse the selected protocol`);
    // Attach a rejection handler now so a failure while later protocols start
    // becomes an explicit per-protocol result rather than an unhandled promise.
    outcomes.push(exercise(session, type).then((value) => ({ value }), (error) => ({ error, type })));
  }
  const naive = structuredClone(generated.outbounds.find((outbound) => outbound.type === "naive"));
  assert.ok(naive, "Naive outbound must be exported");
  naive.tls.certificate_path = ca;
  // Cronet may perform a background IPv6 reachability probe. Binding its
  // dialer to loopback prevents any fixture traffic from leaving this host.
  naive.bind_interface = loopbackInterface;
  const naivePort = await port();
  await startSingBox("naive-client", { log: { level: "info" }, inbounds: [{ type: "mixed", listen: "127.0.0.1", listen_port: naivePort }], outbounds: [naive], route: { final: naive.tag } }, singBoxClient);
  const naiveSession = await connectWebSocket(naivePort, "/echo", caPem);
  outcomes.push(exercise(naiveSession, "naive").then((value) => ({ value }), (error) => ({ error, type: "naive" })));
  const negative = await connectWebSocket(mixed, "/interrupt", caPem);
  await expectFrame(negative, 1, "server-ready");
  await assert.rejects(() => negative.next(3000), /WebSocket stream (?:ended|closed)/, "An interrupted WSS stream must not be reported healthy");
  negative.close();
  console.log(JSON.stringify({ phase: "interrupted-stream-negative-control", detected: true }));
  console.log(JSON.stringify({ phase: "idle-in-progress", protocols: types.length, requestedIdleMs: idleMs, applicationHeartbeat: false }));
  const results = await Promise.all(outcomes);
  for (const result of results) if (result.error) throw new Error(`${result.type}: ${result.error.message}`, { cause: result.error });
  assert.deepEqual(fixtureErrors, [], "WebSocket fixture must not swallow malformed frame failures");
  assert.equal(results.length, types.length);
  console.log(JSON.stringify({ passed: true, protocolsPassed: results.length, serverVersion, clientVersion, naiveClientVersion, idleMs, authenticatedAiRequest: false }));
} catch (error) {
  process.stderr.write(clean(error.stack || error.message) + "\n");
  for (const state of children) process.stderr.write(`${state.name}: ${clean(state.log).slice(-2500)}\n`);
  process.exitCode = 1;
} finally {
  idleController.abort();
  for (const session of sessions) session.close();
  for (const socket of sockets) socket.destroy();
  await Promise.all(outcomes);
  await Promise.all([...children].map(stop));
  if (target?.listening) await new Promise((resolve) => target.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
