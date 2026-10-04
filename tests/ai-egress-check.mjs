// Native Host-pinning acceptance through the public multi-Host compiler and
// full exports. Validate untouched configs before adapting only transports,
// DNS upstreams, listener/controller ports, cache paths and probe intervals to
// loopback fixtures. This proves selection/isolation, not public protocols,
// account eligibility, handset connectivity or physical egress IP stability.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
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

const exec = promisify(execFile);
const run = (binary, args) => exec(binary, args, { timeout: 15000 });
const selectedCore = process.argv.find((arg) => arg.startsWith("--core="))?.split("=")[1];
const negativeControl = process.argv.includes("--negative-control-unpinned");
assert.ok(!selectedCore || ["sing-box", "mihomo", "mihomo-modern"].includes(selectedCore));
const credential = { email: "ai-pinning@example.invalid", runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d", runtimePassword: "isolated-fixture" };
const hostId = "pin", otherId = "pin-extra";
const tcpTag = `raylink-${hostId}-vless`, udpTag = `raylink-${hostId}-hysteria2`, otherTag = `raylink-${otherId}-vless`;
const domains = ["claude.ai", "api.openai.com", "custom-ai.example", "ordinary.example", "health.fixture.invalid"];

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function unusedPort() {
  const server = tcpServer(), port = await listen(server);
  await new Promise((resolve) => server.close(resolve)); return port;
}
function fixture(name, latency) {
  const state = { name, latency, healthy: true, probes: 0, requests: 0, sockets: new Set() };
  const origin = createServer((request, response) => {
    if (request.url === "/probe") {
      state.probes++;
      const timer = setTimeout(() => { response.writeHead(204); response.end(); }, state.latency);
      response.on("close", () => clearTimeout(timer));
    } else { state.requests++; response.end(name); }
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
  state.listen = async () => { await listen(origin); state.port = await listen(state.server); };
  state.disconnect = () => { for (const socket of state.sockets) socket.destroy(); };
  state.close = async () => {
    state.disconnect();
    await Promise.all([origin, state.server].filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))));
  };
  return state;
}
function resolver() {
  const socket = createSocket("udp4"), queries = [];
  socket.on("message", (query, peer) => {
    let end = 12; const labels = [];
    while (query[end]) { const length = query[end++]; labels.push(query.toString("ascii", end, end + length)); end += length; }
    const isA = query.readUInt16BE(end + 1) === 1; end += 5;
    queries.push(labels.join("."));
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(isA ? 1 : 0, 6);
    header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 127, 0, 0, 1]);
    socket.send(Buffer.concat([header, query.subarray(12, end), ...(isA ? [answer] : [])]), peer.port, peer.address);
  });
  return { socket, queries };
}
async function dnsQuery(domain, port) {
  const socket = createSocket("udp4"); let timer;
  const header = Buffer.alloc(12); header.writeUInt16BE(0x4321, 0); header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4);
  const question = Buffer.concat([...domain.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0, 0, 1, 0, 1])]);
  try {
    const received = once(socket, "message"); socket.send(Buffer.concat([header, question]), port, "127.0.0.1");
    const [answer] = await Promise.race([received, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`DNS fixture timed out: ${domain}`)), 2500);
    })]);
    return answer.readUInt16BE(2) & 15;
  } finally { clearTimeout(timer); socket.close(); }
}

async function check(core, scenario) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-ai-egress-"));
  const tcp = fixture("PINNED-TCP", 5), udp = fixture("PINNED-UDP", 60), other = fixture("OTHER-HOST", 1);
  const fixtures = [tcp, udp, other], dns = resolver();
  let child, closed, logs = "", directRequests = 0;
  const origin = createServer((_request, response) => { directRequests++; response.end("DIRECT-LEAK"); });
  try {
    const binary = core === "sing-box" ? process.env.SING_BOX_BIN || "sing-box" : process.env.MIHOMO_BIN || "mihomo";
    const version = (await run(binary, core === "sing-box" ? ["version"] : ["-v"])).stdout.split("\n")[0];
    if (core === "sing-box") assert.match(version, /^sing-box version 1\.14\.2\b/);
    for (const fixture of fixtures) await fixture.listen();
    const originPort = await listen(origin), mixed = await unusedPort(), controller = await unusedPort(), dnsPort = await unusedPort();
    dns.socket.bind(0, "127.0.0.1"); await once(dns.socket, "listening");
    const profiles = defaultProtocolConfigs();
    const profile = (type, port) => ({ ...profiles.find((item) => item.type === type), enabled: true, port,
      ...(type === "hysteria2" ? { tls: { mode: "certificate", serverName: "fixture.invalid" } } : {})
    });
    const hosts = [
      { id: hostId, name: "Same display name", address: "127.0.0.1", protocols: [profile("vless", tcp.port), profile("hysteria2", udp.port)] },
      { id: otherId, name: "Same display name", address: "127.0.0.1", protocols: [profile("vless", other.port)] }
    ];
    const routePolicy = { mode: "smart", aiExit: negativeControl ? { mode: "auto" } : { mode: "pinned", hostId }, rules: [
      { match: "domain", value: "custom-ai.example", action: "ai" },
      { match: "domain", value: "ordinary.example", action: "proxy" }
    ] };
    const generated = buildMultiHostProtocolClientConfig({ credential, routePolicy,
      probeUrl: "http://health.fixture.invalid/probe",
      hosts: scenario === "missing" ? hosts.slice(1)
        : scenario === "ineligible" ? hosts.map((host) => host.id === hostId ? { ...host, protocols: [] } : host) : hosts
    });
    const aiGroup = core === "sing-box" ? "raylink-ai" : "AI 网站代理";
    const stableGroup = core === "sing-box" ? "raylink-ai-stable" : "AI 稳定出口";
    const ordinaryGroup = core === "sing-box" ? "raylink-auto" : "RayLink 代理";
    const manualGroup = core === "mihomo-modern" ? "AI 节点选择" : aiGroup;
    let args;
    if (core === "sing-box") {
      const fullPath = join(directory, "full.json"); await writeFile(fullPath, JSON.stringify(generated));
      await run(binary, ["check", "-c", fullPath]);
      generated.inbounds = [
        { type: "mixed", listen: "127.0.0.1", listen_port: mixed },
        { type: "direct", listen: "127.0.0.1", listen_port: dnsPort, override_address: "8.8.8.8", override_port: 53 }
      ];
      generated.dns.servers = generated.dns.servers.map(({ tag }) => ({ type: "hosts", tag,
        predefined: Object.fromEntries(domains.map((domain) => [domain, ["127.0.0.1"]]))
      }));
      generated.outbounds = generated.outbounds.map((outbound) => outbound.type === "urltest"
        ? { ...outbound, interval: "1s" }
        : outbound.server ? { type: "http", tag: outbound.tag, server: "127.0.0.1", server_port: outbound.server_port } : outbound);
      generated.experimental.cache_file.path = join(directory, "cache.db");
      generated.experimental.clash_api = { external_controller: `127.0.0.1:${controller}` };
      const path = join(directory, "simulation.json"); await writeFile(path, JSON.stringify(generated));
      await run(binary, ["check", "-c", path]); args = ["run", "-c", path];
    } else {
      const body = buildSubscriptionArtifact({ format: core, routePolicy, singBoxConfig: generated }).body;
      const fullPath = join(directory, "full.yaml"); await writeFile(fullPath, body);
      await run(binary, ["-t", "-d", directory, "-f", fullPath]);
      const dnsEndpoint = `udp://127.0.0.1:${dns.socket.address().port}`;
      const yaml = body.replace("mixed-port: 7890", `mixed-port: ${mixed}\nexternal-controller: 127.0.0.1:${controller}\ngeo-auto-update: false\nfind-process-mode: off`)
        .replace(/type: "(?:vless|hysteria2)"/g, 'type: "http"')
        .replace(/^\s+(?:uuid|password|udp|tls|sni|servername|skip-cert-verify):.*\n/gm, "")
        .replace(/interval: (?:60|180)/g, "interval: 1")
        .replaceAll("https://223.5.5.5/dns-query", `${dnsEndpoint}#DIRECT`)
        .replaceAll('"223.5.5.5"', JSON.stringify(dnsEndpoint))
        .replaceAll("https://1.1.1.1/dns-query#AI 网站代理", `${dnsEndpoint}#DIRECT`)
        .replaceAll("https://1.1.1.1/dns-query#RayLink 代理", `${dnsEndpoint}#DIRECT`);
      const path = join(directory, "simulation.yaml"); await writeFile(path, yaml);
      await run(binary, ["-t", "-d", directory, "-f", path]); args = ["-d", directory, "-f", path];
    }
    child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    closed = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
    child.stdout.on("data", (data) => { logs += data; }); child.stderr.on("data", (data) => { logs += data; });
    child.on("error", (error) => { logs += error.message; });
    const api = (path, options = {}) => fetch(`http://127.0.0.1:${controller}${path}`, { signal: AbortSignal.timeout(1500), ...options });
    async function until(test, label, timeout = 14000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) { try { if (await test()) return; } catch {} await delay(50); }
      assert.fail(`${core}/${scenario}: ${label}\n${logs.slice(-4000)}`);
    }
    const proxies = async () => (await (await api("/proxies")).json()).proxies;
    const select = async (group, name) => api(`/proxies/${encodeURIComponent(group)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    const request = async (domain) => (await run("curl", ["--silent", "--show-error", "--fail", "--noproxy", "", "--max-time", "2", "--socks5-hostname", `127.0.0.1:${mixed}`, `http://${domain}:${originPort}/payload`])).stdout;
    await until(async () => !!(await proxies())[ordinaryGroup], "native controller did not start");
    if (core === "sing-box") {
      assert.equal(await dnsQuery("ordinary.example", dnsPort), 0, "ordinary DNS must remain usable");
      for (const domain of ["claude.ai", "custom-ai.example"]) {
        const result = await dnsQuery(domain, dnsPort);
        if (scenario === "present") assert.equal(result, 0, `${domain}: healthy pin DNS failed`);
        else assert.equal(result, 5, `${domain}: unavailable pin DNS should refuse resolution`);
      }
    }
    // Use the public ordinary selector to prove the other Host is usable,
    // regardless of its order or the clients' unrelated automatic selection.
    if (core === "sing-box") assert.equal((await select(ordinaryGroup, otherTag)).status, 204);
    else {
      assert.equal((await select("手动选择", otherTag)).status, 204);
      assert.equal((await select(ordinaryGroup, "手动选择")).status, 204);
    }
    assert.equal(await request("ordinary.example"), other.name);
    if (scenario === "present") {
      const state = await proxies();
      assert.deepEqual(state[stableGroup].all, [tcpTag, udpTag], "AI automatic candidates must contain only the pinned Host, TCP then UDP");
      assert.deepEqual(state[manualGroup].all, core === "mihomo-modern" ? [tcpTag, udpTag] : [stableGroup, tcpTag, udpTag]);
      if (core === "mihomo-modern") assert.deepEqual(state[aiGroup].all, [stableGroup, manualGroup]);
      for (const forbidden of [otherTag, ordinaryGroup, "DIRECT"]) {
        const rejected = await select(manualGroup, forbidden);
        assert.ok(rejected.status >= 400, `${manualGroup} accepted an unpinned choice: ${forbidden}`);
      }
      for (const [tag, marker] of [[tcpTag, tcp.name], [udpTag, udp.name]]) {
        assert.equal((await select(manualGroup, tag)).status, 204);
        if (core === "mihomo-modern") assert.equal((await select(aiGroup, manualGroup)).status, 204);
        assert.equal(await request("claude.ai"), marker);
        assert.equal(await request("custom-ai.example"), marker);
      }
      assert.equal((await select(aiGroup, stableGroup)).status, 204);
      await until(() => tcp.probes >= 2 && udp.probes >= 2 && other.probes >= 1, "initial probe rounds missing");
      await until(async () => await request("claude.ai") === tcp.name, "default AI selection does not use pinned TCP");
      tcp.healthy = false; tcp.disconnect();
      await until(async () => await request("claude.ai") === udp.name, "TCP failure did not recover through same-Host UDP");
      assert.equal(await request("api.openai.com"), udp.name);
      udp.healthy = false; udp.disconnect();
      // Cross Mihomo's selection cache and several active probe rounds. An
      // unpinned provider accidentally in the fallback will then be chosen.
      await delay(core === "sing-box" ? 1500 : 11200);
    }
    const unrelatedRequests = other.requests;
    for (const domain of ["claude.ai", "api.openai.com", "custom-ai.example"]) await assert.rejects(request(domain), `${domain} escaped unavailable pinned Host`);
    assert.equal(other.requests, unrelatedRequests, "AI traffic leaked to an unrelated Host");
    assert.equal(directRequests, 0, "AI traffic leaked to DIRECT");
    assert.equal(await request("ordinary.example"), other.name, "pin failure affected ordinary traffic");
    console.log(JSON.stringify({ core, version, scenario, fullConfigValidated: true, pinnedTcpAndUdp: scenario === "present", sameHostRecovery: scenario === "present", unavailablePinFailsClosed: true, ordinaryHostHealthy: true, directLeaks: directRequests, publicProtocolTested: false }));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await closed; clearTimeout(timer);
    }
    try { dns.socket.close(); } catch {}
    await Promise.all(fixtures.map((fixture) => fixture.close()));
    origin.closeAllConnections(); if (origin.listening) await new Promise((resolve) => origin.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const core of selectedCore ? [selectedCore] : ["sing-box", "mihomo", "mihomo-modern"]) {
  for (const scenario of negativeControl ? ["present"] : ["present", "missing", "ineligible"]) await check(core, scenario);
}
