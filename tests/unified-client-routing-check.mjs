// Native subscription regression, not a production/network acceptance test.
// Keep generated rules, groups, provider filters and fake-IP behavior intact.
// Only replace transport/DNS endpoints and listeners with isolated fixtures;
// never enable TUN, change the system proxy, or read a user's client config.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildMultiHostProtocolClientConfig, defaultProtocolConfigs } from "../server/singbox/protocol-catalog.js";
import { buildSubscriptionArtifact, stringifyYaml } from "../server/subscriptions/formats.js";

const run = promisify(execFile);
const binary = process.env.MIHOMO_BIN || "mihomo";
const deferredStartup = process.argv.includes("--deferred-startup");
const directory = await mkdtemp(join(tmpdir(), "raylink-unified-routing-"));
const fixtures = new Map();
const resolvers = [];
let core;
let coreClosed;
let log = "";
let base;
let mixedPort;
let requestNumber = 0;
let pendingStartup;
let startupFailure;

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function unusedPort() {
  const server = createTcpServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`${message}\n${log.slice(-3000)}`);
}
async function stopCore() {
  if (core && core.exitCode === null && core.signalCode === null) {
    core.kill("SIGTERM");
    const timer = setTimeout(() => core.kill("SIGKILL"), 1500);
    try { await coreClosed; } finally { clearTimeout(timer); }
  }
  core = undefined;
}
async function api(path, body) {
  const response = await fetch(`${base}${path}`, {
    ...(body ? { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(3000)
  });
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.status === 204 ? null : response.json();
}
async function select(group, name) {
  await api(`/proxies/${encodeURIComponent(group)}`, { name });
  assert.equal((await api(`/proxies/${encodeURIComponent(group)}`)).now, name);
}

async function waitForProfile(format, nodes, aiNodes) {
  // Mihomo starts its controller before executor.ApplyConfig installs proxies,
  // listeners and providers. /version alone therefore says nothing about the
  // requested profile. Keep the strict membership assertions below this gate.
  const groups = ["AI 网站代理", "未分类流量", "RayLink 代理", "手动选择"];
  const paths = ["/configs", "/proxies", "/providers/rules", ...(format === "mihomo-modern" ? ["/providers/proxies"] : [])];
  let observed = {};
  const requireRunning = () => {
    if (startupFailure) throw startupFailure;
    if (core.exitCode !== null || core.signalCode !== null || core.pid === undefined) {
      throw new Error(`Mihomo exited before profile readiness (code=${core.exitCode}, signal=${core.signalCode})\n${log.slice(-3000)}`);
    }
  };
  try {
    await waitFor(async () => {
      requireRunning();
      const results = await Promise.all(paths.map(async (path) => {
        try {
          const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(1000) });
          if (!response.ok) { await response.body?.cancel(); return { path, status: response.status }; }
          return { path, status: response.status, value: await response.json() };
        } catch { return { path, status: "unavailable" }; }
      }));
      requireRunning();
      const values = Object.fromEntries(results.map(({ path, value }) => [path, value]));
      const proxies = values["/proxies"]?.proxies || {};
      const providerNodes = values["/providers/proxies"]?.providers?.["raylink-health"]?.proxies?.map(({ name }) => name) || [];
      const rules = values["/providers/rules"]?.providers || {};
      observed = {
        statuses: Object.fromEntries(results.map(({ path, status }) => [path, status])),
        missingGroups: groups.filter((name) => !Array.isArray(proxies[name]?.all) || !proxies[name].all.length),
        missingNodes: nodes.filter((name) => !proxies[name]),
        aiCandidates: proxies["AI 网站代理"]?.all || [],
        providerCandidates: providerNodes,
        ruleCounts: ["raylink-cn-domain", "raylink-cn-ip"].map((name) => rules[name]?.ruleCount || 0),
        listenerReady: values["/configs"]?.["mixed-port"] === mixedPort
      };
      return results.every(({ status }) => status === 200)
        && observed.listenerReady && !observed.missingGroups.length && !observed.missingNodes.length
        && aiNodes.every((name) => observed.aiCandidates.includes(name))
        && (format !== "mihomo-modern" || nodes.every((name) => providerNodes.includes(name)))
        && observed.ruleCounts.every((count) => count > 0);
    }, "Native Mihomo profile did not become ready", 10000);
  } catch (error) {
    throw new Error(`${format}: profile startup state ${JSON.stringify(observed)}\n${error.message}`, { cause: error });
  }
}

// HTTP proxies return distinct payloads and retain request records. A stopped
// fixture is an actual refused TCP connection, not a mocked health status.
function proxyFixture(name, marker) {
  const sockets = new Set();
  const requests = [];
  const server = createServer((request, response) => {
    if (request.method === "HEAD") { response.writeHead(204); response.end(); return; }
    requests.push(new URL(request.url, `http://${request.headers.host}`).host);
    setTimeout(() => response.end(marker), 180);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, socket, head) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let content = Buffer.alloc(0);
    const receive = (chunk) => {
      content = Buffer.concat([content, chunk]);
      if (!content.includes("\r\n\r\n")) return;
      socket.off("data", receive);
      const health = content.toString("ascii").startsWith("HEAD ");
      if (!health) requests.push(request.url);
      setTimeout(() => socket.end(health
        ? "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"
        : `HTTP/1.1 200 OK\r\nContent-Length: ${marker.length}\r\nConnection: close\r\n\r\n${marker}`), health ? 0 : 180);
    };
    socket.on("data", receive);
    if (head.length) receive(head);
  });
  const fixture = { name, marker, server, sockets, requests };
  fixtures.set(name, fixture);
  return fixture;
}
async function stopFixture(fixture) {
  for (const socket of fixture.sockets) socket.destroy();
  if (fixture.server.listening) await new Promise((resolve) => fixture.server.close(resolve));
}

async function resolver(name, address) {
  const socket = createSocket("udp4");
  socket.on("message", (query, peer) => {
    let end = 12;
    while (query[end]) end += query[end] + 1;
    const isA = query.readUInt16BE(end + 1) === 1;
    end += 5;
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(isA ? 1 : 0, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 5, 0, 4, ...address]);
    socket.send(Buffer.concat([header, query.subarray(12, end), ...(isA ? [answer] : [])]), peer.port, peer.address);
  });
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  const result = { name, socket, endpoint: `udp://127.0.0.1:${socket.address().port}#DIRECT` };
  resolvers.push(result);
  return result;
}
async function dnsAddress(domain, port) {
  const client = createSocket("udp4");
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x6123, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const question = Buffer.concat([
    ...domain.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0, 0, 1, 0, 1])
  ]);
  const timer = setTimeout(() => client.emit("error", new Error(`DNS timeout: ${domain}`)), 3000);
  try {
    const response = once(client, "message");
    client.send(Buffer.concat([header, question]), port, "127.0.0.1");
    const [answer] = await response;
    assert.equal(answer.readUInt16BE(2) & 15, 0);
    assert.equal(answer.readUInt16BE(6), 1, `${domain}: expected one A answer`);
    return [...answer.subarray(-4)].join(".");
  } finally { clearTimeout(timer); client.close(); }
}

async function request(domain, targetPort, expected, rule, chains) {
  // A delayed response lets us inspect this request's real native connection,
  // rather than infer its route from the exported YAML or marker alone.
  const pending = run("curl", ["--silent", "--show-error", "--fail", "--noproxy", "", "--max-time", "3",
    "--socks5-hostname", `127.0.0.1:${mixedPort}`, `http://${domain}:${targetPort}/case-${++requestNumber}`], { timeout: 5000 });
  const outcome = pending.then((result) => ({ result }), (error) => ({ error }));
  let connection;
  try {
    connection = await waitFor(async () => ((await api("/connections")).connections || []).find((item) => item.metadata.host === domain),
      `${domain}: request missing from native connections`, 2500);
  } finally {
    const completed = await outcome;
    if (completed.error) throw completed.error;
    assert.equal(completed.result.stdout, expected, `${domain}: incorrect actual fixture exit`);
  }
  assert.equal(connection.rule, rule, `${domain}: incorrect native matching rule`);
  assert.deepEqual(connection.chains, chains, `${domain}: incorrect native strategy chain`);
}

const origin = createServer((_request, response) => setTimeout(() => response.end("DIRECT"), 180));
try {
  await chmod(directory, 0o700);
  const version = (await run(binary, ["-v"])).stdout.trim().split("\n")[0];
  const targetPort = await listen(origin);
  const domestic = await resolver("domestic", [127, 0, 0, 1]);
  // 0.0.0.0 connects only to the local origin while not matching the generated
  // private/CN CIDR rules. This preserves MATCH behavior without replacing any
  // routing rule, installing routes, or contacting an external test endpoint.
  const remote = await resolver("remote", [0, 0, 0, 0]);
  const aiDns = await resolver("ai", [0, 0, 0, 0]);
  const credential = { email: "fixture@example.invalid", runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d", runtimePassword: "fixture-only" };
  const profiles = defaultProtocolConfigs().filter(({ type }) => ["vmess", "vless"].includes(type)).map((profile) => ({ ...profile, enabled: true }));
  const hosts = [
    { id: "pinned", address: "pinned.fixture.invalid", protocols: profiles },
    { id: "other", address: "other.fixture.invalid", protocols: profiles.filter(({ type }) => type === "vless") }
  ];
  const aiFirst = "raylink-pinned-vmess";
  const aiChosen = "raylink-pinned-vless";
  const ordinary = "raylink-other-vless";
  const expectedAi = [aiFirst, aiChosen];

  for (const format of ["mihomo", "mihomo-modern"]) {
    const formatDir = join(directory, format);
    await mkdir(formatDir, { mode: 0o700 });
    for (const [name, marker] of [[aiFirst, "AI_FIRST"], [aiChosen, "AI_CHOSEN"], [ordinary, "ORDINARY"]]) {
      const fixture = proxyFixture(name, marker);
      fixture.port = await listen(fixture.server);
    }
    mixedPort = await unusedPort();
    const controllerPort = await unusedPort();
    const dnsPort = await unusedPort();
    base = `http://127.0.0.1:${controllerPort}`;
    const routePolicy = { mode: "smart", aiSelection: "manual", aiExit: { mode: "pinned", hostId: "pinned" } };
    const generated = buildMultiHostProtocolClientConfig({ hosts, credential, probeUrl: `http://127.0.0.1:${targetPort}/health`, routePolicy });
    const exported = buildSubscriptionArtifact({ format, singBoxConfig: generated, routePolicy }).body;
    const fixtureProxies = [...fixtures.values()].map(({ name, port }) => ({ name, type: "http", server: "127.0.0.1", port }));
    let yaml = exported.replace(/^mixed-port:.*$/m, `mixed-port: ${mixedPort}\nexternal-controller: "127.0.0.1:${controllerPort}"\nfind-process-mode: off\ngeo-auto-update: false`)
      .replace('log-level: "info"', 'log-level: "debug"')
      .replace('  enhanced-mode: "fake-ip"', `  enhanced-mode: "fake-ip"\n  listen: "127.0.0.1:${dnsPort}"`)
      .replaceAll("https://223.5.5.5/dns-query", domestic.endpoint)
      .replaceAll("https://1.1.1.1/dns-query#AI 网站代理", aiDns.endpoint)
      .replaceAll("https://1.1.1.1/dns-query#RayLink 代理", remote.endpoint)
      .replaceAll('"223.5.5.5"', JSON.stringify(`127.0.0.1:${domestic.socket.address().port}`))
      .replaceAll('"system"', JSON.stringify(domestic.endpoint));
    if (format === "mihomo") {
      yaml = yaml.replace(/\nproxies:\n[\s\S]*?(?=\nproxy-groups:\n)/, `\n${stringifyYaml({ proxies: fixtureProxies }).trimEnd()}`);
    } else {
      yaml = yaml.replace(/    payload:\n[\s\S]*?(?=    health-check:\n)/,
        stringifyYaml({ payload: fixtureProxies }).split("\n").filter(Boolean).map((line) => `    ${line}\n`).join(""));
    }
    assert.ok(!yaml.includes("fixture.invalid"), "Only the fixture transports may remain in the isolated native config");
    const path = join(formatDir, "config.yaml");
    await writeFile(path, yaml, { mode: 0o600 });
    await run(binary, ["-t", "-d", formatDir, "-f", path], { timeout: 10000 });
    let startupPath = path;
    if (deferredStartup && format === "mihomo-modern") {
      // Make the controller/config readiness gap deterministic using the real
      // native API, then load the unchanged generated profile shortly after.
      startupPath = join(formatDir, "bootstrap.yaml");
      await writeFile(startupPath, `external-controller: "127.0.0.1:${controllerPort}"\nlog-level: debug\nfind-process-mode: off\ngeo-auto-update: false\n`, { mode: 0o600 });
    }
    log = "";
    core = spawn(binary, ["-d", formatDir, "-f", startupPath], { stdio: ["ignore", "pipe", "pipe"] });
    coreClosed = new Promise((resolve) => { core.once("exit", resolve); core.once("error", resolve); });
    const capture = (chunk) => { log = (log + chunk).slice(-16000); };
    core.stdout.on("data", capture);
    core.stderr.on("data", capture);
    core.on("error", (error) => capture(error.message));
    await waitFor(async () => {
      if (core.exitCode !== null || core.signalCode !== null) throw new Error(log);
      try { return (await fetch(`${base}/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, "Native Mihomo controller did not start");
    if (deferredStartup && format === "mihomo-modern") {
      const absent = await fetch(`${base}/proxies/${encodeURIComponent("AI 网站代理")}`, { signal: AbortSignal.timeout(1000) });
      assert.equal(absent.status, 404, "Controller-only bootstrap must not contain subscription groups");
      await absent.body?.cancel();
      console.log(JSON.stringify({ format, phase: "controller-before-profile", versionAvailable: true, aiGroupStatus: 404 }));
      pendingStartup = delay(250).then(() => api("/configs?force=true", { path })).then(() => null, error => { startupFailure = error; return error; });
    }
    await waitForProfile(format, fixtureProxies.map(({ name }) => name), expectedAi);
    if (pendingStartup) {
      const failure = await pendingStartup;
      pendingStartup = undefined;
      if (failure) throw failure;
    }
    const aiGroup = await api(`/proxies/${encodeURIComponent("AI 网站代理")}`);
    assert.equal(aiGroup.type, "Selector");
    assert.deepEqual(aiGroup.all, expectedAi, `${format}: AI provider membership must not add other Hosts or automatic groups`);
    assert.equal(aiGroup.now, aiFirst);
    const unknown = await api(`/proxies/${encodeURIComponent("未分类流量")}`);
    assert.equal(unknown.type, "Selector");
    assert.deepEqual(unknown.all, ["RayLink 代理", "DIRECT"]);
    assert.equal(unknown.now, "RayLink 代理");
    await select("手动选择", ordinary);
    await select("RayLink 代理", "手动选择");
    await select("AI 网站代理", aiChosen);

    for (const domain of ["localhost", "printer.lan", "router.local", "router.home.arpa"]) {
      assert.equal(await dnsAddress(domain, dnsPort), "127.0.0.1", `${format}: ${domain} must avoid fake-IP`);
    }
    assert.match(await dnsAddress("unclassified.fixture.invalid", dnsPort), /^198\.18\./, "Fake-IP must remain enabled for ordinary domains");
    for (const direct of [false, true]) {
      if (direct) await select("未分类流量", "DIRECT");
      await request("unclassified.fixture.invalid", targetPort, direct ? "DIRECT" : "ORDINARY", "Match",
        direct ? ["DIRECT", "未分类流量"] : [ordinary, "手动选择", "RayLink 代理", "未分类流量"]);
      await request("unlisted-domestic-fixture.cn", targetPort, "DIRECT", "DomainSuffix", ["DIRECT"]);
      await request("blog.csdn.net", targetPort, "DIRECT", "RuleSet", ["DIRECT"]);
      await request("www.google.com.hk", targetPort, "ORDINARY", "DomainSuffix", [ordinary, "手动选择", "RayLink 代理"]);
      await request("chatgpt.com", targetPort, "AI_CHOSEN", "DomainSuffix", [aiChosen, "AI 网站代理"]);
      await request("aistudio.google.com", targetPort, "AI_CHOSEN", "Domain", [aiChosen, "AI 网站代理"]);
    }

    const beforeFailure = new Map([...fixtures].map(([name, fixture]) => [name, fixture.requests.filter((request) => request.startsWith("chatgpt.com:")).length]));
    assert.equal(beforeFailure.get(aiChosen), 2, "Both earlier AI payloads must have used the manually selected fixture");
    await stopFixture(fixtures.get(aiChosen));
    await assert.rejects(() => run("curl", ["--silent", "--show-error", "--fail", "--noproxy", "", "--max-time", "3",
      "--socks5-hostname", `127.0.0.1:${mixedPort}`, `http://chatgpt.com:${targetPort}/unavailable`], { timeout: 5000 }),
    "A manually fixed AI node failure must fail the request, never silently fall back");
    assert.equal((await api(`/proxies/${encodeURIComponent("AI 网站代理")}`)).now, aiChosen);
    for (const [name, fixture] of fixtures) {
      assert.equal(fixture.requests.filter((request) => request.startsWith("chatgpt.com:")).length, beforeFailure.get(name), `${name}: AI outage leaked to another exit`);
    }
    await request("www.google.com.hk", targetPort, "ORDINARY", "DomainSuffix", [ordinary, "手动选择", "RayLink 代理"]);
    await request("unlisted-domestic-fixture.cn", targetPort, "DIRECT", "DomainSuffix", ["DIRECT"]);
    console.log(JSON.stringify({ format, manualAiMembership: expectedAi, unknownSwitchIsolated: true, lanFakeIpExcluded: true,
      aiOutageDoesNotChangeNode: true, realNativeConnections: 14, scope: "loopback fixtures only" }));
    await stopCore();
    for (const fixture of fixtures.values()) await stopFixture(fixture);
    fixtures.clear();
  }
  console.log(JSON.stringify({ version, passed: true, scope: "synthetic native regression; not production or handset acceptance" }));
} finally {
  await pendingStartup;
  await stopCore();
  for (const fixture of fixtures.values()) await stopFixture(fixture);
  for (const { socket } of resolvers) socket.close();
  origin.closeAllConnections();
  if (origin.listening) await new Promise((resolve) => origin.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
