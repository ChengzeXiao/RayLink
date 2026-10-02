// Native API-stream selection regression. The complete exported groups/rules
// remain intact; remote transports are replaced with local HTTP proxies and
// probe intervals are compressed to 1s. This cannot prove carrier/AI-provider
// reliability. Set --idle-ms=70000 to exercise a >60s gap between SSE events.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect, createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildMultiHostProtocolClientConfig, defaultProtocolConfigs } from "../server/singbox/protocol-catalog.js";
import { buildSubscriptionArtifact } from "../server/subscriptions/formats.js";

const run = promisify(execFile);
const idleMs = Number(process.argv.find((arg) => arg.startsWith("--idle-ms="))?.split("=")[1] || 1500);
const selectedCore = process.argv.find((arg) => arg.startsWith("--core="))?.split("=")[1];
const negativeControl = process.argv.includes("--negative-control-modern-default");
assert.ok(Number.isInteger(idleMs) && idleMs >= 100 && idleMs <= 120000, "idle-ms must be 100..120000");
assert.ok(!selectedCore || ["sing-box", "mihomo", "mihomo-modern"].includes(selectedCore), "unsupported core");
assert.ok(!negativeControl || selectedCore === "mihomo-modern", "the modern-default negative control requires --core=mihomo-modern");
const credential = { email: "ai-stream@example.invalid", runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d", runtimePassword: "isolated-fixture" };
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function unusedPort() {
  const server = tcpServer(); const port = await listen(server);
  await new Promise((resolve) => server.close(resolve)); return port;
}
function fixture(name, latency) {
  const state = { name, latency, healthy: true, probes: 0, sockets: new Set(), streams: new Set() };
  const origin = createServer((request, response) => {
    if (request.url === "/probe") {
      state.probes++;
      const timer = setTimeout(() => { response.writeHead(204); response.end(); }, state.latency);
      response.on("close", () => clearTimeout(timer));
    } else if (request.url === "/stream" || request.url === "/idle-stream") {
      state.streams.add(response);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${name}:0\n\n`);
      const tick = () => { if (!response.destroyed) response.write(`data: ${name}:1\n\n`); };
      const timer = request.url === "/stream" ? setInterval(tick, 50) : setTimeout(() => { tick(); response.end("data: [DONE]\n\n"); }, idleMs);
      response.on("close", () => { clearInterval(timer); clearTimeout(timer); state.streams.delete(response); });
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
async function check(core) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-ai-stream-"));
  const primary = fixture("PRIMARY", 5), backup = fixture("BACKUP", 60);
  const children = new Set(); let logs = ""; let controller;
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
    if (controller) {
      try {
        const response = await fetch(`http://127.0.0.1:${controller}/proxies`);
        const state = (await response.json()).proxies;
        logs += "\n" + JSON.stringify(Object.fromEntries(Object.entries(state).filter(([name]) => ["raylink-primary-vless", "raylink-backup-vless", "AI 稳定出口", "AI 网站代理"].includes(name))));
      } catch {}
    }
    throw new Error(`${core}: ${label}\n${logs.slice(-5000)}`);
  }
  try {
    const primaryPort = await primary.listen(), backupPort = await backup.listen(), mixed = await unusedPort();
    const profile = defaultProtocolConfigs().find((candidate) => candidate.type === "vless");
    const generated = buildMultiHostProtocolClientConfig({ credential, probeUrl: "http://health.fixture.invalid/probe", hosts: [
      { id: "primary", address: "127.0.0.1", protocols: [{ ...profile, enabled: true, port: primaryPort }] },
      { id: "backup", address: "127.0.0.1", protocols: [{ ...profile, enabled: true, port: backupPort }] }
    ], routePolicy: { mode: "smart" } });
    let binary, args;
    if (core === "sing-box") {
      binary = process.env.SING_BOX_BIN || "sing-box";
      assert.match((await run(binary, ["version"])).stdout, /^sing-box version 1\.14\.2\b/);
      generated.inbounds = [{ type: "mixed", listen: "127.0.0.1", listen_port: mixed }];
      generated.dns.servers = generated.dns.servers.map(({ tag }) => ({ type: "hosts", tag, predefined: { "api.openai.com": ["203.0.113.1"], "health.fixture.invalid": ["203.0.113.2"] } }));
      generated.outbounds = generated.outbounds.map((outbound) => outbound.type === "urltest"
        ? { ...outbound, interval: "1s" }
        : outbound.server ? { type: "http", tag: outbound.tag, server: "127.0.0.1", server_port: outbound.server_port } : outbound);
      generated.experimental.cache_file.path = join(directory, "cache.db");
      const path = join(directory, "config.json"); await writeFile(path, JSON.stringify(generated));
      await run(binary, ["check", "-c", path]); args = ["run", "-c", path];
    } else {
      binary = process.env.MIHOMO_BIN || "mihomo";
      controller = await unusedPort();
      await run(binary, ["-v"]);
      let yaml = buildSubscriptionArtifact({ format: core, singBoxConfig: generated }).body
        .replace("mixed-port: 7890", `mixed-port: ${mixed}\nexternal-controller: 127.0.0.1:${controller}\ngeo-auto-update: false\nfind-process-mode: off`)
        .replaceAll('type: "vless"', 'type: "http"').replace(/^\s+uuid:.*\n/gm, "")
        .replace(/interval: (?:60|180)/g, "interval: 1");
      if (negativeControl) {
        // Recreate the old modern selector: provider nodes precede explicit
        // groups in Mihomo, silently making its first concrete node the default.
        const start = yaml.indexOf('name: "AI 网站代理"'), end = yaml.indexOf("\n  - ", start);
        assert.ok(start >= 0 && end > start, "AI selector must exist");
        const regressed = yaml.slice(start, end) + '\n    use:\n      - "raylink-health"\n    filter: "^raylink-primary-vless$`^raylink-backup-vless$"';
        yaml = yaml.slice(0, start) + regressed + yaml.slice(end);
      }
      const path = join(directory, "config.yaml"); await writeFile(path, yaml);
      args = ["-d", directory, "-f", path]; await run(binary, ["-t", ...args]);
    }
    const runtime = launch(binary, args);
    runtime.child.stdout.on("data", (data) => { logs += data; }); runtime.child.stderr.on("data", (data) => { logs += data; });
    const curlArgs = (path = "/payload") => ["--silent", "--show-error", "--fail", "--noproxy", "", "--max-time", "3", "--socks5-hostname", `127.0.0.1:${mixed}`, `http://api.openai.com${path}`];
    const request = async () => (await run("curl", curlArgs())).stdout;
    const stream = (path) => { const args = curlArgs(path); args[args.indexOf("--max-time") + 1] = String(Math.ceil(idleMs / 1000) + 20); return launch("curl", ["--no-buffer", ...args]); };
    await until(async () => await request() === "PRIMARY", "initial AI exit unavailable");
    await until(() => primary.probes >= 2 && backup.probes >= 2, "initial health checks incomplete");
    const idle = stream("/idle-stream");
    await until(() => idle.stdout.includes("PRIMARY:0"), "SSE response did not start");
    await until(() => idle.stdout.includes("[DONE]"), "idle API stream lost its second event", idleMs + 5000);
    await idle.closed;
    assert.equal(idle.child.exitCode, 0, idle.stderr);
    assert.match(idle.stdout, /PRIMARY:0\n\ndata: PRIMARY:1\n\ndata: \[DONE\]/);
    console.log(JSON.stringify({ core, phase: "idle-sse", idleMs, complete: true }));
    const active = stream("/stream");
    await until(() => active.stdout.includes("PRIMARY"), "active API stream missing");
    primary.latency = 350; backup.latency = 5;
    const before = active.stdout.length;
    // Mihomo caches its selected candidate for 10s; cross that boundary.
    await delay(11200);
    assert.equal(await request(), "PRIMARY", `${core}: ordinary latency changes must not move the healthy AI exit`);
    assert.equal(active.child.exitCode, null, active.stderr);
    assert.ok(active.stdout.length > before, "SSE did not advance across health checks");
    primary.healthy = false; primary.disconnect();
    await until(async () => await request() === "BACKUP", "new requests did not fail over from a failed primary", 15000);
    const backupStream = stream("/stream");
    await until(() => backupStream.stdout.includes("BACKUP"), "backup API stream missing");
    const recoveryProbes = primary.probes; const backupBytes = backupStream.stdout.length;
    primary.latency = 5; backup.latency = 60; primary.healthy = true;
    await until(() => primary.probes > recoveryProbes, "recovered primary was not probed");
    await delay(400);
    const recoveredSelections = [];
    for (let i = 0; i < 10; i++) {
      const actual = await request(); recoveredSelections.push(actual);
      if (core === "sing-box") assert.equal(actual, "BACKUP", "sing-box must retain its healthy AI exit");
      else assert.ok(["BACKUP", "PRIMARY"].includes(actual), "Mihomo must use a healthy exit during recovery");
      await delay(150);
    }
    if (core !== "sing-box") assert.ok(recoveredSelections.includes("PRIMARY"), "Mihomo ordered fallback must recover its preferred primary");
    assert.equal(backupStream.child.exitCode, null, backupStream.stderr);
    assert.ok(backupStream.stdout.length > backupBytes, "backup SSE stalled on primary recovery");
    console.log(JSON.stringify({ core, phase: "failed-primary-recovery", recoveryPolicy: core === "sing-box" ? "keep-current" : "ordered-primary", establishedSseContinues: true, healthProbeIntervalMs: 1000 }));
    if (core === "mihomo-modern") {
      const choose = async (group, name) => {
        const response = await fetch(`http://127.0.0.1:${controller}/proxies/${encodeURIComponent(group)}`, {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name })
        });
        assert.equal(response.status, 204, await response.text());
      };
      await choose("AI 网站代理", "AI 节点选择");
      await choose("AI 节点选择", "raylink-backup-vless");
      await choose("手动选择", "raylink-primary-vless");
      assert.equal(await request(), "BACKUP", "manual AI exit must stay independent of ordinary manual selection");
      await choose("AI 网站代理", "AI 稳定出口");
      assert.equal(await request(), "PRIMARY", "returning AI to automatic selection must use its recovered primary");
      assert.equal(backupStream.child.exitCode, null, backupStream.stderr);
      console.log(JSON.stringify({ core, phase: "independent-manual-ai", apiUsesBackup: true, ordinaryManualUsesPrimary: true, automaticRestored: true }));
    }
  } finally {
    for (const state of children) {
      if (state.child.exitCode === null && state.child.signalCode === null) {
        state.child.kill("SIGTERM"); const timer = setTimeout(() => state.child.kill("SIGKILL"), 2000);
        await state.closed; clearTimeout(timer);
      }
    }
    await primary.close(); await backup.close(); await rm(directory, { recursive: true, force: true });
  }
}
for (const core of selectedCore ? [selectedCore] : ["sing-box", "mihomo", "mihomo-modern"]) await check(core);
