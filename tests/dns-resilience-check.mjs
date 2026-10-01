import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildProtocolClientConfig, defaultProtocolConfigs } from "../server/singbox/protocol-catalog.js";

const binary = process.env.SING_BOX_BIN || "sing-box";
const directory = await mkdtemp(join(tmpdir(), "raylink-dns-"));
const upstream = createSocket("udp4");
const reservation = createSocket("udp4");
let child;
let drop = false;
let answer = 11;
let requests = 0;
let log = "";
let requestId = 0;
const bind = async (socket) => { socket.bind(0, "127.0.0.1"); await once(socket, "listening"); return socket.address().port; };
function packet(name) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(++requestId, 0);
  header.writeUInt16BE(0x100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, ...name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0, 0, 1, 0, 1])]);
}
async function query(port, name) {
  const socket = createSocket("udp4");
  const start = performance.now();
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`test DNS deadline exceeded for ${name}; upstreamRequests=${requests}; logs=${log}`)), 7000);
      socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
      socket.once("message", (response) => {
        clearTimeout(timeout);
        resolve({ rcode: response[3] & 15, answer: response.at(-1), elapsedMs: performance.now() - start });
      });
      socket.send(packet(name), port, "127.0.0.1");
    });
  } finally { socket.close(); }
}
async function queryTcpTimeout(port, name) {
  const socket = createConnection({ host: "127.0.0.1", port });
  const start = performance.now();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("DNS TCP deadline exceeded")), 7000);
      socket.once("connect", () => {
        const request = packet(name);
        const header = Buffer.alloc(2);
        header.writeUInt16BE(request.length);
        socket.write(Buffer.concat([header, request]));
      });
      socket.once("data", () => { clearTimeout(timer); reject(new Error("unexpected DNS answer during outage")); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
      socket.once("close", () => { clearTimeout(timer); resolve(performance.now() - start); });
    });
  } finally { socket.destroy(); }
}

try {
  assert.match(execFileSync(binary, ["version"], { encoding: "utf8" }), /^sing-box version 1\.14\.2\b/);
  const upstreamPort = await bind(upstream);
  const inboundPort = await bind(reservation);
  reservation.close();
  upstream.on("message", (request, remote) => {
    requests++;
    if (drop) return;
    const response = Buffer.from(request);
    response.writeUInt16BE(0x8180, 2);
    response.writeUInt16BE(1, 6);
    // A record with TTL 1s lets the test observe real expiry and background refresh.
    const rr = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 203, 0, 113, answer]);
    upstream.send(Buffer.concat([response, rr]), remote.port, remote.address);
  });
  const config = buildProtocolClientConfig({ profiles: defaultProtocolConfigs(), server: "127.0.0.1",
    probeUrl: "http://127.0.0.1:9/generate_204",
    credential: { email: "dns@example.com", runtimePassword: randomBytes(16).toString("base64"),
      serverPassword: randomBytes(16).toString("base64") } });
  // Replace only environmental endpoints. Retain generated DNS/cache/routing policy.
  config.dns.servers = config.dns.servers.map(({ tag }) => ({ type: "udp", tag,
    server: "127.0.0.1", server_port: upstreamPort }));
  config.inbounds = [{ type: "direct", listen: "127.0.0.1", listen_port: inboundPort,
    override_address: "8.8.8.8", override_port: 53 }];
  config.experimental.cache_file.path = join(directory, "cache.db");
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(config));
  child = spawn(binary, ["run", "-c", path], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  for (let i = 0; i < 100 && !log.includes("sing-box started") && child.exitCode === null; i++) await delay(50);
  assert.ok(log.includes("sing-box started"), log);
  assert.equal((await query(inboundPort, "stale.example.test")).answer, 11);
  await delay(1300);
  drop = true;
  const stale = await query(inboundPort, "stale.example.test");
  assert.equal(stale.rcode, 0);
  assert.equal(stale.answer, 11);
  assert.ok(stale.elapsedMs < 1000, "cached DNS must remain responsive during upstream loss");
  const timeoutMs = await queryTcpTimeout(inboundPort, "uncached.example.test");
  assert.ok(timeoutMs >= 4000 && timeoutMs < 6500, "DNS TCP failure must be bounded near 5s");
  drop = false;
  answer = 22;
  await query(inboundPort, "stale.example.test");
  let refreshed;
  for (let i = 0; i < 30; i++) {
    await delay(100);
    refreshed = await query(inboundPort, "stale.example.test");
    if (refreshed.answer === 22) break;
  }
  assert.equal(refreshed.answer, 22, "DNS must recover automatically when upstream resumes");
  process.stdout.write(`${JSON.stringify({ runtime: "1.14.2", upstreamPacketLoss: "100%",
    staleReplyMs: Math.round(stale.elapsedMs), uncachedTimeoutMs: Math.round(timeoutMs),
    recoveredAnswer: "203.0.113.22", upstreamRequests: requests })}\n`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(timer);
  }
  try { upstream.close(); } catch { /* Already closed on startup failure. */ }
  try { reservation.close(); } catch { /* Port reservation was released before startup. */ }
  await rm(directory, { recursive: true, force: true });
}
