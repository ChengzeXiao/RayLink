import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildSingBoxConfig } from "../server/singbox/config.js";

const run = promisify(execFile);
const binary = process.env.SING_BOX_BIN || "sing-box";
const directory = await mkdtemp(join(tmpdir(), "raylink-runtime-dns-"));
const target = createServer((_request, response) => response.end("runtime-dns-fixture"));
const upstreams = [];
let child;
let log = "";

async function upstream() {
  const socket = createSocket("udp4");
  const state = { socket, queries: [], mode: "answer" };
  upstreams.push(state);
  socket.on("message", (request, remote) => {
    let offset = 12;
    const labels = [];
    while (request[offset]) {
      const length = request[offset++];
      labels.push(request.subarray(offset, offset + length).toString());
      offset += length;
    }
    offset++;
    const queryType = request.readUInt16BE(offset);
    offset += 4;
    state.queries.push(labels.join("."));
    if (state.mode === "drop") return;
    const response = Buffer.from(request.subarray(0, offset));
    response.writeUInt16BE(state.mode === "servfail" ? 0x8182 : 0x8180, 2);
    response.writeUInt16BE(0, 6);
    response.writeUInt16BE(0, 8);
    response.writeUInt16BE(0, 10);
    if (state.mode === "answer" && [1, 28].includes(queryType)) {
      response.writeUInt16BE(1, 6);
      const answer = queryType === 1
        ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1])
        : Buffer.from([0xc0, 0x0c, 0, 28, 0, 1, 0, 0, 0, 60, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
      socket.send(Buffer.concat([response, answer]), remote.port, remote.address);
    } else socket.send(response, remote.port, remote.address);
  });
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  state.port = socket.address().port;
  return state;
}

async function unusedPort() {
  const listener = createTcpServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function request(socksPort, domain) {
  const started = performance.now();
  const result = await run("curl", ["--silent", "--show-error", "--fail", "--noproxy", "", "--max-time", "16",
    "--socks5-hostname", `127.0.0.1:${socksPort}`, `http://${domain}:${target.address().port}/`], { timeout: 18000 });
  assert.equal(result.stdout, "runtime-dns-fixture");
  return Math.round(performance.now() - started);
}

try {
  const version = (await run(binary, ["version"])).stdout.match(/^sing-box version (\S+)/)?.[1];
  assert.match(version || "", /^1\.(13|14)\./, "Runtime DNS regression requires supported sing-box 1.13/1.14");
  const primary = await upstream();
  const secondary = await upstream();
  const local = await upstream();
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const config = buildSingBoxConfig({ host: { kind: "local", runtimeVersion: version }, users: [], protocols: [], masterPassword: "fixture" },
    { runtimeDns: { privateSuffixes: ["corp.example"] } });
  const productionPath = join(directory, "production.json");
  await writeFile(productionPath, JSON.stringify(config));
  await run(binary, ["check", "-c", productionPath], { timeout: 10000 });
  // Change only environmental DNS endpoints. Keep the generated routing,
  // resolver selection, response fallback and cache behavior intact.
  if (config.dns) config.dns.servers = config.dns.servers.map(server => ({
    type: "udp", tag: server.tag, server: "127.0.0.1",
    server_port: server.tag === "runtime-primary" ? primary.port : server.tag === "runtime-secondary" ? secondary.port : local.port
  }));
  const socksPort = await unusedPort();
  config.inbounds = [{ type: "socks", listen: "127.0.0.1", listen_port: socksPort }];
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(config));
  child = spawn(binary, ["run", "-c", path], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { log = (log + chunk).slice(-32768); });
  child.stderr.on("data", chunk => { log = (log + chunk).slice(-32768); });
  for (let count = 0; count < 100 && !log.includes("sing-box started") && child.exitCode === null; count++) await delay(50);
  assert.ok(log.includes("sing-box started"), log);
  await request(socksPort, "healthy.runtime-dns.invalid");
  assert.ok(primary.queries.includes("healthy.runtime-dns.invalid"), "outbound domain resolution must use the configured trusted resolver");
  assert.equal(secondary.queries.length, 0, "healthy primary must not race a competing CDN answer");
  const beforeCache = primary.queries.length;
  primary.mode = "drop";
  const cacheMs = await request(socksPort, "healthy.runtime-dns.invalid");
  assert.equal(primary.queries.length, beforeCache, "valid cached answers must survive upstream loss");
  assert.ok(cacheMs < 1000);
  const fallbackMs = await request(socksPort, "timeout.runtime-dns.invalid");
  assert.ok(secondary.queries.includes("timeout.runtime-dns.invalid"), "primary timeout must really query the secondary resolver");
  assert.ok(fallbackMs < (version.startsWith("1.14.") ? 5000 : 14000));
  primary.mode = "servfail";
  await request(socksPort, "failure.runtime-dns.invalid");
  assert.ok(secondary.queries.includes("failure.runtime-dns.invalid"), "SERVFAIL must fall back too");
  primary.mode = "answer";
  await request(socksPort, "recovered.runtime-dns.invalid");
  assert.ok(primary.queries.includes("recovered.runtime-dns.invalid"));
  assert.ok(!secondary.queries.includes("recovered.runtime-dns.invalid"));
  const publicQueryCount = primary.queries.length + secondary.queries.length;
  for (const domain of ["printer", "service.local", "service.internal", "service.home.arpa", "service.corp.example"]) {
    await request(socksPort, domain);
    assert.ok(local.queries.includes(domain), `${domain} must keep local DNS`);
  }
  assert.equal(primary.queries.length + secondary.queries.length, publicQueryCount, "private names must not reach public resolvers");
  local.mode = "servfail";
  await assert.rejects(() => request(socksPort, "missing.corp.example"));
  assert.equal(primary.queries.length + secondary.queries.length, publicQueryCount, "failed private queries must not leak to public fallback");
  const localQueryCount = local.queries.length;
  primary.mode = secondary.mode = "servfail";
  await assert.rejects(() => request(socksPort, "both-failed.runtime-dns.invalid"));
  assert.ok(secondary.queries.includes("both-failed.runtime-dns.invalid"));
  assert.equal(local.queries.length, localQueryCount, "public resolver failures must not silently restore untrusted system DNS");
  await request(socksPort, "127.0.0.1");
  process.stdout.write(`${JSON.stringify({ runtime: version, trustedLookup: true, cacheMs, timeoutFallbackMs: fallbackMs,
    servfailFallback: true, primaryRecovery: true, privateNamesStayLocal: true, failureDoesNotLeak: true, literalIpWorks: true })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n${log}\n`);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(timer);
  }
  for (const upstream of upstreams) upstream.socket.close();
  if (target.listening) await new Promise(resolve => target.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
