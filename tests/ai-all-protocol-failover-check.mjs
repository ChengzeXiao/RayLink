// Native AI selection regression for TCP failure with a healthy UDP-protocol
// candidate. Generated groups/rules stay intact; both remote transports become
// loopback HTTP fixtures. This tests selection, not real QUIC transport or AI
// provider access. Public protocol and authenticated model tests remain separate.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect, createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildMultiHostProtocolClientConfig, defaultProtocolConfigs } from "../server/singbox/protocol-catalog.js";
import { buildSubscriptionArtifact } from "../server/subscriptions/formats.js";

const exec = promisify(execFile);
const run = (binary, args, options = {}) => exec(binary, args, { timeout: 10000, ...options });
const selectedCore = process.argv.find((arg) => arg.startsWith("--core="))?.split("=")[1];
assert.ok(!selectedCore || ["sing-box", "mihomo", "mihomo-modern", "egern-structure"].includes(selectedCore));
const credential = { email: "ai-failover@example.invalid", runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d", runtimePassword: "isolated-fixture" };

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function unusedPort() {
  const server = tcpServer(); const port = await listen(server);
  await new Promise((resolve) => server.close(resolve)); return port;
}

function fixture(name, latency) {
  const state = { name, latency, healthy: true, probes: 0, sockets: new Set() };
  const origin = createServer((request, response) => {
    if (request.url === "/probe") {
      state.probes++;
      const timer = setTimeout(() => { response.writeHead(204); response.end(); }, state.latency);
      response.on("close", () => clearTimeout(timer));
    } else if (request.url === "/stream") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${name}:0\n\n`);
      const timer = setInterval(() => response.write(`data: ${name}:1\n\n`), 50);
      response.on("close", () => clearInterval(timer));
    } else response.end(name);
  });
  state.server = createServer();
  for (const server of [origin, state.server]) server.on("connection", (socket) => {
    state.sockets.add(socket); socket.on("close", () => state.sockets.delete(socket));
  });
  state.server.on("connect", (_request, socket, head) => {
    if (!state.healthy) { socket.destroy(); return; }
    const upstream = connect(origin.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy()); upstream.on("close", () => socket.destroy());
  });
  state.listen = async () => { await listen(origin); return listen(state.server); };
  state.disconnect = () => { for (const socket of state.sockets) socket.destroy(); };
  state.close = async () => {
    state.disconnect();
    await Promise.all([origin, state.server].filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))));
  };
  return state;
}

function generate(tcpPort, udpPort) {
  const profiles = defaultProtocolConfigs();
  const tcp = profiles.find((profile) => profile.type === "vless");
  const udp = profiles.find((profile) => profile.type === "hysteria2");
  return buildMultiHostProtocolClientConfig({ credential, probeUrl: "http://health.fixture.invalid/probe", hosts: [
    { id: "primary", address: "127.0.0.1", protocols: [{ ...tcp, enabled: true, port: tcpPort }] },
    { id: "recovery", address: "127.0.0.1", protocols: [{ ...udp, enabled: true, port: udpPort }] }
  ], routePolicy: { mode: "smart" } });
}

function checkEgernStructure() {
  const yaml = buildSubscriptionArtifact({ format: "egern-profile", singBoxConfig: generate(41001, 41002) }).body;
  const stable = yaml.split('name: "AI 稳定出口"')[1].split(/\n  - /)[0];
  const tcp = stable.indexOf('"raylink-primary-vless"');
  const udp = stable.indexOf('"raylink-recovery-hysteria2"');
  assert.ok(tcp >= 0 && udp > tcp, "Egern AI stable fallback must try TCP before a UDP-protocol recovery candidate");
  assert.match(yaml, /close_connections_on_policy_change: false/);
  console.log(JSON.stringify({ core: "egern-structure", tcpBeforeUdp: true, nativeClientTested: false }));
}

async function check(core) {
  if (core === "egern-structure") return checkEgernStructure();
  const directory = await mkdtemp(join(tmpdir(), "raylink-ai-all-protocol-"));
  const tcp = fixture("TCP", 5), udp = fixture("UDP", 60);
  const children = new Set(); let logs = "";
  function launch(binary, args) {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    const state = { child, stdout: "", stderr: "", closed: new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); }) };
    child.stdout.on("data", (data) => { state.stdout += data; });
    child.stderr.on("data", (data) => { state.stderr += data; });
    child.on("error", (error) => { state.stderr += error.message; });
    children.add(state); return state;
  }
  async function until(test, label, timeout = 10000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { if (await test()) return; } catch {} await delay(50); }
    throw new Error(`${core}: ${label}; TCP probes=${tcp.probes}, UDP probes=${udp.probes}\n${logs.slice(-1500)}`);
  }
  try {
    const tcpPort = await tcp.listen(), udpPort = await udp.listen(), mixed = await unusedPort();
    const generated = generate(tcpPort, udpPort);
    let binary, args;
    if (core === "sing-box") {
      binary = process.env.SING_BOX_BIN || "sing-box";
      assert.match((await run(binary, ["version"])).stdout, /^sing-box version 1\.14\.2\b/);
      generated.inbounds = [{ type: "mixed", listen: "127.0.0.1", listen_port: mixed }];
      generated.dns.servers = generated.dns.servers.map(({ tag }) => ({ type: "hosts", tag, predefined: {
        "claude.ai": ["203.0.113.1"], "api.anthropic.com": ["203.0.113.1"], "health.fixture.invalid": ["203.0.113.2"]
      } }));
      generated.outbounds = generated.outbounds.map((outbound) => outbound.type === "urltest"
        ? { ...outbound, interval: "1s" }
        : outbound.server ? { type: "http", tag: outbound.tag, server: "127.0.0.1", server_port: outbound.server_port } : outbound);
      generated.experimental.cache_file.path = join(directory, "cache.db");
      const path = join(directory, "config.json"); await writeFile(path, JSON.stringify(generated));
      await run(binary, ["check", "-c", path]); args = ["run", "-c", path];
    } else {
      binary = process.env.MIHOMO_BIN || "mihomo";
      const yaml = buildSubscriptionArtifact({ format: core, singBoxConfig: generated }).body
        .replace("mixed-port: 7890", `mixed-port: ${mixed}\ngeo-auto-update: false\nfind-process-mode: off`)
        .replace(/type: "(?:vless|hysteria2)"/g, 'type: "http"')
        .replace(/^\s+(?:uuid|password|udp):.*\n/gm, "")
        .replace(/interval: (?:60|180)/g, "interval: 1");
      const path = join(directory, "config.yaml"); await writeFile(path, yaml);
      args = ["-d", directory, "-f", path]; await run(binary, ["-t", ...args]);
    }
    const runtime = launch(binary, args);
    runtime.child.stdout.on("data", (data) => { logs += data; }); runtime.child.stderr.on("data", (data) => { logs += data; });
    const curlArgs = (host = "claude.ai", path = "/payload") => ["--silent", "--show-error", "--fail", "--noproxy", "", "--max-time", "3", "--socks5-hostname", `127.0.0.1:${mixed}`, `http://${host}${path}`];
    const request = async (host) => (await run("curl", curlArgs(host))).stdout;
    const startStream = () => {
      const streamArgs = curlArgs("claude.ai", "/stream");
      streamArgs[streamArgs.indexOf("--max-time") + 1] = "35";
      return launch("curl", ["--no-buffer", ...streamArgs]);
    };
    await until(async () => await request() === "TCP", "initial AI exit unavailable");
    await until(() => tcp.probes >= 2 && udp.probes >= 2, "both protocol candidates were not health-checked");
    assert.equal(await request("api.anthropic.com"), "TCP");
    console.log(JSON.stringify({ core, phase: "initial-tcp", udpCandidateHealthy: true }));
    const active = startStream();
    await until(() => active.stdout.includes("TCP:0"), "initial TCP SSE did not start");
    const activeBytes = active.stdout.length;
    tcp.latency = 350; udp.latency = 1;
    // A newly faster UDP candidate must not destabilize an already healthy AI
    // exit. Wait beyond Mihomo's 10s cached selection before asserting this.
    await delay(11200);
    assert.equal(await request(), "TCP", "latency reversal must not move the healthy AI exit");
    assert.equal(active.child.exitCode, null, active.stderr);
    assert.ok(active.stdout.length > activeBytes, "initial TCP SSE stopped on latency reversal");
    console.log(JSON.stringify({ core, phase: "latency-reversal", healthyExitUnchanged: true, establishedSseContinues: true }));
    tcp.healthy = false; tcp.disconnect();
    await until(async () => await request() === "UDP", "Claude.ai did not recover through the healthy UDP-protocol candidate after every TCP candidate failed", 12000);
    assert.equal(await request("api.anthropic.com"), "UDP");
    const stream = startStream();
    await until(() => stream.stdout.includes("UDP:0"), "recovery SSE did not start");
    const before = stream.stdout.length, tcpProbes = tcp.probes;
    tcp.latency = 5; tcp.healthy = true;
    await until(() => tcp.probes > tcpProbes, "recovered TCP candidate was not probed");
    // Cross Mihomo's 10s selection cache before judging whether recovery kills
    // an established stream. Different cores may retain or restore the exit.
    await delay(11200);
    assert.ok(["TCP", "UDP"].includes(await request()));
    assert.equal(stream.child.exitCode, null, stream.stderr);
    assert.ok(stream.stdout.length > before, "recovery SSE stopped when TCP returned");
    console.log(JSON.stringify({ core, phase: "udp-recovery", claudeAndApiReachable: true, establishedSseContinues: true }));
  } finally {
    for (const state of children) {
      if (state.child.exitCode === null && state.child.signalCode === null) {
        state.child.kill("SIGTERM"); const timer = setTimeout(() => state.child.kill("SIGKILL"), 2000);
        await state.closed; clearTimeout(timer);
      }
    }
    await tcp.close(); await udp.close(); await rm(directory, { recursive: true, force: true });
  }
}

for (const core of selectedCore ? [selectedCore] : ["sing-box", "mihomo", "mihomo-modern", "egern-structure"]) await check(core);
