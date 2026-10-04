// Native selection simulation: public generated groups, loopback HTTP proxy
// fixtures in place of remote transports, and a 1s compressed probe interval.
// This checks routing/selection semantics, not QUIC transport or mobile SLA.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildMultiHostProtocolClientConfig, defaultProtocolConfigs } from "../server/singbox/protocol-catalog.js";

const run = promisify(execFile);
const binary = process.env.SING_BOX_BIN || "sing-box";
// This deliberate regression must fail the healthy-AI-exit assertion.
const lowToleranceControl = process.argv.includes("--negative-control-low-ai-tolerance");
const directory = await mkdtemp(join(tmpdir(), "raylink-failover-"));
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function unusedPort() {
  const server = createTcpServer(); const port = await listen(server);
  await new Promise((resolve) => server.close(resolve)); return port;
}
function fixture(name, latency) {
  const state = { name, latency, probes: 0, sockets: new Set(), streams: new Set() };
  state.server = createServer((_req, response) => response.end(name));
  state.server.on("connection", (socket) => {
    state.sockets.add(socket); socket.on("close", () => state.sockets.delete(socket));
  });
  state.server.on("connect", (_req, socket, head) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let request = head.toString();
    const onData = (data) => {
      request += data.toString();
      if (!request.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      if (/^(GET|HEAD) \/probe\b/.test(request)) {
        state.probes++;
        setTimeout(() => {
          if (!socket.destroyed) socket.end("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
        }, state.latency);
      } else if (/^GET \/stream\b/.test(request)) {
        state.streams.add(socket);
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n");
        const timer = setInterval(() => { if (!socket.destroyed) socket.write(`${name}\n`); }, 50);
        socket.on("close", () => { clearInterval(timer); state.streams.delete(socket); });
      } else {
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${name.length}\r\nConnection: close\r\n\r\n${name}`);
      }
    };
    socket.on("data", onData);
    if (head.length) onData(Buffer.alloc(0));
  });
  state.stop = async () => {
    for (const socket of state.sockets) socket.destroy();
    if (state.server.listening) await new Promise((resolve) => state.server.close(resolve));
  };
  return state;
}
const primary = fixture("PRIMARY", 10);
const backup = fixture("BACKUP", 180);
const quic = fixture("QUIC-CANDIDATE", 1);
const fixtures = [primary, backup, quic];
let directRequests = 0;
const origin = createServer((_req, response) => { directRequests++; response.end("DIRECT"); });
let child, stream;
let logs = "", streamData = "", streamErrors = "";
async function until(check, label, timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(`${label}\n${logs.slice(-6000)}`);
}
try {
  assert.match((await run(binary, ["version"])).stdout, /^sing-box version 1\.14\.2\b/);
  const originPort = await listen(origin);
  for (const fixture of fixtures) fixture.port = await listen(fixture.server);
  const inboundPort = await unusedPort();
  const vless = defaultProtocolConfigs().find((profile) => profile.type === "vless");
  const config = buildMultiHostProtocolClientConfig({
    credential: { email: "simulation@example.test", runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d", serverPassword: "AAAAAAAAAAAAAAAAAAAAAA==" },
    probeUrl: `http://127.0.0.1:${originPort}/probe`,
    hosts: ["primary", "backup", "quic"].map((id) => ({
      id, address: `${id}.example.test`, protocols: [{ ...vless, enabled: true,
        ...(id === "quic" ? { transport: { type: "quic" }, tls: { mode: "certificate", serverName: "quic.example.test" } } : {})
      }]
    })),
    routePolicy: { rules: [{ match: "domain", value: "ordinary.example.test", action: "proxy" }] }
  });
  config.log.level = "debug";
  config.inbounds = [{ type: "mixed", tag: "simulation", listen: "127.0.0.1", listen_port: inboundPort }];
  // Deterministic resolution only if an unintended direct route is selected.
  config.dns.servers = config.dns.servers.map(({ tag }) => ({ type: "hosts", tag, predefined: {
    "ordinary.example.test": ["127.0.0.1"], "chatgpt.com": ["127.0.0.1"]
  } }));
  config.outbounds = config.outbounds.map((outbound) => {
    if (outbound.type === "urltest") return { ...outbound, interval: "1s",
      ...(lowToleranceControl && outbound.tag === "raylink-ai-stable" ? { tolerance: 50 } : {})
    };
    if (!outbound.server) return outbound;
    const fixture = fixtures.find((item) => outbound.tag === `raylink-${item === quic ? "quic" : item === primary ? "primary" : "backup"}-vless`);
    assert.ok(fixture, `unmapped fixture: ${outbound.tag}`);
    return { type: "http", tag: outbound.tag, server: "127.0.0.1", server_port: fixture.port };
  });
  config.experimental.cache_file.path = join(directory, "cache.db");
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(config));
  await run(binary, ["check", "-c", path]);
  child = spawn(binary, ["run", "-c", path], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => { logs += data; }); child.stderr.on("data", (data) => { logs += data; });
  await until(() => logs.includes("sing-box started"), "runtime did not start");
  const curlArgs = (domain, path = "/") => ["--silent", "--show-error", "--fail", "--max-time", "3", "--noproxy", "", "--socks5-hostname", `127.0.0.1:${inboundPort}`, `http://${domain}:${originPort}${path}`];
  const request = async (domain) => (await run("curl", curlArgs(domain))).stdout;
  // Activate both generated selections and wait for their first health rounds.
  await request("ordinary.example.test"); await request("chatgpt.com");
  await until(() => primary.probes >= 2 && backup.probes >= 2 && quic.probes >= 1, "initial probe rounds missing");
  assert.equal(await request("ordinary.example.test"), "PRIMARY");
  assert.equal(await request("chatgpt.com"), "PRIMARY");
  console.log("TCP default and AI choose PRIMARY despite faster QUIC-classified candidate");
  const streamArgs = curlArgs("chatgpt.com", "/stream");
  streamArgs[streamArgs.indexOf("--max-time") + 1] = "30";
  stream = spawn("curl", ["--no-buffer", ...streamArgs], { stdio: ["ignore", "pipe", "pipe"] });
  stream.stdout.on("data", (data) => { streamData += data; }); stream.stderr.on("data", (data) => { streamErrors += data; });
  await until(() => streamData.includes("PRIMARY"), "AI stream failed to open");
  primary.latency = 350; backup.latency = 5;
  await until(async () => await request("ordinary.example.test") === "BACKUP", "TCP group did not select improved backup");
  const before = streamData.length;
  await delay(1800);
  assert.equal(await request("chatgpt.com"), "PRIMARY", "AI should keep its healthy exit through ordinary latency changes");
  assert.equal(stream.exitCode, null, streamErrors);
  assert.ok(streamData.length > before, "AI stream stopped delivering data during re-probes");
  assert.equal(primary.streams.size, 1);
  console.log("AI exit and sustained stream survive latency reversal and re-probes");
  await primary.stop();
  await until(async () => { try { return ["BACKUP", "QUIC-CANDIDATE"].includes(await request("chatgpt.com")); } catch { return false; } }, "AI did not fail over after primary failure");
  assert.equal(await request("ordinary.example.test"), "BACKUP");
  console.log("failed primary: AI selects a reachable candidate; ordinary connections select TCP backup");
  await backup.stop();
  await assert.rejects(request("ordinary.example.test"));
  await until(async () => { try { return await request("chatgpt.com") === "QUIC-CANDIDATE"; } catch { return false; } }, "AI did not recover through the surviving UDP candidate");
  assert.equal(directRequests, 0, "TCP failures must not leak to DIRECT");
  console.log("all TCP candidates fail: AI recovers through UDP; ordinary TCP selection stays isolated");
  await quic.stop();
  await assert.rejects(request("chatgpt.com"));
  await assert.rejects(request("ordinary.example.test"));
  assert.equal(directRequests, 0, "proxy failures must not leak to DIRECT");
  console.log("all protocol candidates fail: requests fail closed without DIRECT leakage");
} finally {
  if (stream && stream.exitCode === null && stream.signalCode === null) {
    const exited = once(stream, "exit"); stream.kill("SIGTERM"); await exited;
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await exited; clearTimeout(timer);
  }
  await Promise.all(fixtures.map((fixture) => fixture.stop()));
  origin.closeAllConnections(); await new Promise((resolve) => origin.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
