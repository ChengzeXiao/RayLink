// Native DNS/routing regression through the public subscription generator.
// DNS answers, transport endpoints and final DIRECT dial targets are loopback
// fixtures. Generated DNS policies, fallback filters and route rules are intact.
// This test neither reads client credentials nor changes TUN/system routing.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildSubscriptionArtifact, stringifyYaml } from "../server/subscriptions/formats.js";

const run = promisify(execFile);
const binary = process.env.MIHOMO_BIN || "mihomo";
const dnsEdgeOnly = process.argv.includes("--dns-edge-only");
const directory = await mkdtemp(join(tmpdir(), "raylink-domestic-dns-"));
const cn = "157.255.138.45";
const foreign = "128.14.165.153";
const observedCdn = "wx-love-img.afunapp.com";
const resolvers = [];
const proxies = [];
const delegatedRequests = [];
const originRequests = [];
let proxyResolver;
let core;
let coreClosed;
let log = "";
let base;
let mixedPort;
let remoteUnavailable = false;
let remoteDelayMs = 800;

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
    const value = await check();
    if (value) return value;
    await delay(15);
  }
  throw new Error(`${message}\n${log.slice(-4000)}`);
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
    signal: AbortSignal.timeout(9000)
  });
  assert.ok(response.ok, `${path}: native API returned ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function select(group, name) {
  await api(`/proxies/${encodeURIComponent(group)}`, { name });
  assert.equal((await api(`/proxies/${encodeURIComponent(group)}`)).now, name);
}

function answerFor(name, domain) {
  if (name === "direct-dial") return { addresses: ["127.0.0.1"] };
  if (name === "proxy-exit") return { addresses: ["127.0.0.1"] };
  if (name === "ai") return { addresses: [cn] };
  if (name === "remote") return remoteUnavailable ? null : {
    addresses: [domain === "forced-proxy.fixture.invalid" ? cn : foreign], delay: remoteDelayMs
  };
  if (domain.startsWith("domestic-timeout")) return null;
  if (name === "domestic" && domain === "primary-down-cn.fixture.invalid") return null;
  if (domain === "domestic-servfail.fixture.invalid") return { rcode: 2, addresses: [] };
  if (domain === "domestic-nxdomain.fixture.invalid") return { rcode: 3, addresses: [] };
  if (domain === "domestic-empty.fixture.invalid") return { addresses: [] };
  if (domain === "mixed-cn-first.fixture.invalid") return { addresses: [cn, foreign] };
  if (domain === "mixed-foreign-first.fixture.invalid") return { addresses: [foreign, cn] };
  if (domain === "private-answer.fixture.invalid") return { addresses: ["127.0.0.99"] };
  if (domain === "unlisted-foreign.fixture.invalid") return { addresses: ["1.1.1.1"] };
  return { addresses: [cn] };
}

async function resolver(name) {
  const socket = createSocket("udp4");
  const queries = [];
  const timers = new Set();
  socket.on("message", (query, peer) => {
    let end = 12;
    const labels = [];
    while (query[end]) { const size = query[end++]; labels.push(query.toString("ascii", end, end + size)); end += size; }
    const domain = labels.join(".");
    const type = query.readUInt16BE(end + 1);
    end += 5;
    queries.push({ domain, type });
    const result = answerFor(name, domain);
    if (!result) return;
    const addresses = type === 1 ? result.addresses : [];
    const httpsHint = type === 65 && domain === "https-hint.fixture.invalid";
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(0x8180 | (result.rcode || 0), 2);
    header.writeUInt16BE(httpsHint ? 1 : addresses.length, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    const answers = addresses.map((address) => Buffer.from([
      0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 5, 0, 4, ...address.split(".").map(Number)
    ]));
    if (httpsHint) answers.push(Buffer.from([
      0xc0, 0x0c, 0, 65, 0, 1, 0, 0, 0, 5, 0, 11,
      0, 1, 0, 0, 4, 0, 4, ...foreign.split(".").map(Number)
    ]));
    const timer = setTimeout(() => {
      timers.delete(timer);
      socket.send(Buffer.concat([header, query.subarray(12, end), ...answers]), peer.port, peer.address);
    }, result.delay || 1);
    timers.add(timer);
  });
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  const result = { name, socket, queries, timers, endpoint: `udp://127.0.0.1:${socket.address().port}#DIRECT` };
  resolvers.push(result);
  return result;
}

function proxyFixture(name, marker) {
  const sockets = new Set();
  const server = createServer((_request, response) => setTimeout(() => response.end(marker), 150));
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("connect", (request, socket, head) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let content = Buffer.alloc(0);
    const receive = (chunk) => {
      content = Buffer.concat([content, chunk]);
      if (!content.includes("\r\n\r\n")) return;
      socket.off("data", receive);
      const health = content.toString("ascii").startsWith("HEAD ");
      if (!health && request.url.startsWith("domestic-timeout.fixture.invalid:")) {
        // The DNS budget is exhausted before native IP routing. Prove that
        // the original hostname reaches the HTTP proxy, which independently
        // resolves it and forwards the HTTP request to a real loopback origin.
        const target = new URL(`http://${request.url}`);
        void (async () => {
          const answer = await wireQuery(target.hostname, proxyResolver.socket.address().port, 1);
          assert.equal(answer.rcode, 0);
          assert.equal(answer.address, "127.0.0.1");
          delegatedRequests.push({ authority: request.url, hostname: target.hostname, address: answer.address });
          const upstream = createConnection({ host: answer.address, port: Number(target.port) });
          sockets.add(upstream);
          upstream.on("close", () => sockets.delete(upstream));
          upstream.on("error", () => socket.destroy());
          socket.on("close", () => upstream.destroy());
          await once(upstream, "connect");
          upstream.write(content.toString("ascii").replace("\r\n\r\n", `\r\nX-Fixture-Exit: ${marker}\r\n\r\n`));
          socket.pipe(upstream);
          upstream.pipe(socket);
        })().catch(() => socket.destroy());
        return;
      }
      setTimeout(() => socket.end(health
        ? "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"
        : `HTTP/1.1 200 OK\r\nContent-Length: ${marker.length}\r\nConnection: close\r\n\r\n${marker}`), health ? 0 : 150);
    };
    socket.on("data", receive);
    if (head.length) receive(head);
  });
  const fixture = { name, server, sockets };
  proxies.push(fixture);
  return fixture;
}

async function wireQuery(domain, port, type, timeoutMs = 2000) {
  const socket = createSocket("udp4");
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x7134, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const question = Buffer.concat([
    ...domain.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0, type >> 8, type & 255, 0, 1])
  ]);
  const timer = setTimeout(() => socket.emit("error", new Error(`${domain}: DNS type ${type} timed out`)), timeoutMs);
  try {
    const pending = once(socket, "message");
    socket.send(Buffer.concat([header, question]), port, "127.0.0.1");
    const [answer] = await pending;
    const count = answer.readUInt16BE(6);
    return { rcode: answer.readUInt16BE(2) & 15, count, address: type === 1 && count ? [...answer.subarray(-4)].join(".") : null,
      trailingIpv4: type === 65 && count ? [...answer.subarray(-4)].join(".") : null };
  } finally { clearTimeout(timer); socket.close(); }
}
async function fakeAddress(domain, port) {
  const answer = await wireQuery(domain, port, 1);
  assert.equal(answer.rcode, 0);
  assert.equal(answer.count, 1);
  return answer.address;
}

const origin = createServer((request, response) => {
  originRequests.push({ host: request.headers.host, path: request.url, exit: request.headers["x-fixture-exit"] || "DIRECT" });
  setTimeout(() => response.end(request.headers["x-fixture-exit"] || "DIRECT"), 150);
});
try {
  const version = (await run(binary, ["-v"])).stdout.trim().split("\n")[0];
  const targetPort = await listen(origin);
  const domestic = await resolver("domestic");
  const secondary = await resolver("domestic-secondary");
  const remote = await resolver("remote");
  const ai = await resolver("ai");
  const directDial = await resolver("direct-dial");
  proxyResolver = await resolver("proxy-exit");
  const primary = proxyFixture("fixture-primary", "PROXY");
  const aiProxy = proxyFixture("fixture-ai", "AI");
  for (const fixture of proxies) fixture.port = await listen(fixture.server);
  const outbound = (tag) => ({ type: "vless", tag, server: "127.0.0.1", server_port: 443, uuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d" });
  const routePolicy = { mode: "smart", aiSelection: "manual", rules: [
    { match: "domain", value: "forced-proxy.fixture.invalid", action: "proxy", dns: "remote" },
    { match: "domain", value: "forced-direct.fixture.invalid", action: "direct", dns: "domestic" }
  ] };

  for (const format of ["mihomo", "mihomo-modern"]) {
    remoteUnavailable = false;
    remoteDelayMs = 800;
    const formatDir = join(directory, format);
    await mkdir(formatDir, { mode: 0o700 });
    mixedPort = await unusedPort();
    const dnsPort = await unusedPort();
    const controllerPort = await unusedPort();
    base = `http://127.0.0.1:${controllerPort}`;
    const exported = buildSubscriptionArtifact({ format, routePolicy, singBoxConfig: { outbounds: [
      outbound(primary.name), outbound(aiProxy.name), { type: "urltest", tag: "raylink-tcp", outbounds: [primary.name, aiProxy.name] }
    ] } }).body;
    let yaml = exported.replace(/^mixed-port:.*$/m, `mixed-port: ${mixedPort}\nexternal-controller: "127.0.0.1:${controllerPort}"\nfind-process-mode: off\ngeo-auto-update: false`)
      .replace('log-level: "info"', 'log-level: "debug"')
      // DIRECT dial redirection happens only after native route classification;
      // the candidate IP stays public CN/foreign for the unchanged matcher.
      .replace('  enhanced-mode: "fake-ip"', `  enhanced-mode: "fake-ip"\n  listen: "127.0.0.1:${dnsPort}"\n  direct-nameserver: ["${directDial.endpoint}"]\n  direct-nameserver-follow-policy: false`)
      .replaceAll("https://223.5.5.5/dns-query", domestic.endpoint)
      .replaceAll("https://223.6.6.6/dns-query", secondary.endpoint)
      .replaceAll("https://1.1.1.1/dns-query#AI 网站代理", ai.endpoint)
      .replaceAll("https://1.1.1.1/dns-query#RayLink 代理", remote.endpoint)
      .replaceAll('"223.5.5.5"', JSON.stringify(`127.0.0.1:${domestic.socket.address().port}`))
      .replaceAll('"system"', JSON.stringify(domestic.endpoint));
    const transports = proxies.map(({ name, port }) => ({ name, type: "http", server: "127.0.0.1", port }));
    if (format === "mihomo") {
      yaml = yaml.replace(/\nproxies:\n[\s\S]*?(?=\nproxy-groups:\n)/, `\n${stringifyYaml({ proxies: transports }).trimEnd()}`);
    } else {
      yaml = yaml.replace(/    payload:\n[\s\S]*?(?=    health-check:\n)/,
        stringifyYaml({ payload: transports }).split("\n").filter(Boolean).map((line) => `    ${line}\n`).join(""));
    }
    const path = join(formatDir, "config.yaml");
    await writeFile(path, yaml, { mode: 0o600 });
    const validationStart = performance.now();
    await run(binary, ["-t", "-d", formatDir, "-f", path], { timeout: 10000 });
    const validationMs = Math.round(performance.now() - validationStart);
    log = "";
    core = spawn(binary, ["-d", formatDir, "-f", path], { stdio: ["ignore", "pipe", "pipe"] });
    coreClosed = new Promise((resolve) => { core.once("exit", resolve); core.once("error", resolve); });
    const capture = (chunk) => { log = (log + chunk).slice(-20000); };
    core.stdout.on("data", capture);
    core.stderr.on("data", capture);
    await waitFor(async () => {
      if (core.exitCode !== null || core.signalCode !== null) throw new Error(log);
      try {
        const [config, groups, providers] = await Promise.all([api("/configs"), api("/proxies"), api("/providers/rules")]);
        return config["mixed-port"] === mixedPort && groups.proxies?.["AI 网站代理"]?.all?.includes(aiProxy.name)
          && providers.providers?.["raylink-cn-ip"]?.ruleCount > 0;
      } catch { return false; }
    }, `${format}: generated native profile did not become ready`, 10000);
    await select("手动选择", primary.name);
    await select("RayLink 代理", "手动选择");
    await select("AI 网站代理", aiProxy.name);
    console.log(JSON.stringify({ format, version, profileBytes: Buffer.byteLength(exported), validationMs }));

    const cases = [
      { domain: observedCdn, marker: "DIRECT", rule: "RuleSet", payload: "raylink-cn-ip", dns: ["domestic"], budget: 500 },
      { domain: "primary-down-cn.fixture.invalid", marker: "DIRECT", rule: "RuleSet", payload: "raylink-cn-ip", dns: ["domestic"], budget: 500, secondaryRequired: true },
      { domain: "unlisted-foreign.fixture.invalid", marker: "PROXY", rule: "Match", dns: ["domestic", "remote"] },
      { domain: "private-answer.fixture.invalid", marker: "PROXY", rule: "Match", dns: ["domestic", "remote"] },
      { domain: "mixed-cn-first.fixture.invalid", marker: "PROXY", rule: "Match", dns: ["domestic", "remote"] },
      { domain: "mixed-foreign-first.fixture.invalid", marker: "PROXY", rule: "Match", dns: ["domestic", "remote"] },
      { domain: "domestic-nxdomain.fixture.invalid", marker: "PROXY", rule: "Match", dns: ["domestic", "remote"] },
      { domain: "domestic-servfail.fixture.invalid", marker: "PROXY", rule: "Match", dns: ["domestic", "remote"] },
      { domain: "domestic-empty.fixture.invalid", marker: "PROXY", rule: "Match", dns: ["domestic", "remote"] },
      { domain: "domestic-timeout.fixture.invalid", marker: "PROXY", rule: "Match", dns: ["domestic"], budget: 8000, delegated: true },
      { domain: "chatgpt.com", marker: "AI", rule: "DomainSuffix", dns: ["ai"], prime: true },
      { domain: "www.google.com", marker: "PROXY", rule: "DomainSuffix", dns: ["remote"], prime: true },
      { domain: "forced-proxy.fixture.invalid", marker: "PROXY", rule: "Domain", dns: ["remote"], prime: true },
      { domain: "forced-direct.fixture.invalid", marker: "DIRECT", rule: "Domain", dns: ["domestic"], prime: true },
      { domain: "remote-down-cn.fixture.invalid", marker: "DIRECT", rule: "RuleSet", payload: "raylink-cn-ip", dns: ["domestic"], budget: 500, remoteDown: true }
    ];
    for (const test of dnsEdgeOnly ? [] : cases) {
      for (const resolver of resolvers) resolver.queries.length = 0;
      delegatedRequests.length = 0;
      originRequests.length = 0;
      remoteUnavailable = Boolean(test.remoteDown);
      if (test.prime) {
        const answer = await api(`/dns/query?name=${test.domain}&type=A`);
        assert.equal(answer.Status, 0, `${test.domain}: explicit policy DNS failed`);
      }
      const address = await fakeAddress(test.domain, dnsPort);
      const started = performance.now();
      const pending = run("curl", ["--silent", "--show-error", "--fail", "--noproxy", "", "--max-time", "9",
        "--socks5-hostname", `127.0.0.1:${mixedPort}`, "--header", `Host: ${test.domain}:${targetPort}`,
        `http://${address}:${targetPort}/probe`], { timeout: 10000 })
        .then((result) => ({ result }), (error) => ({ error }));
      let connection;
      let result;
      try {
        connection = await waitFor(async () => ((await api("/connections")).connections || []).find((item) => item.metadata.host === test.domain),
          `${test.domain}: native connection not observed`, 8500);
      } finally {
        result = await pending;
        if (result.error) throw new Error(`${test.domain}: request failed: ${result.error.stderr || result.error.message}\n${log.slice(-3000)}`);
      }
      const elapsedMs = Math.round(performance.now() - started);
      const queried = resolvers.filter(({ name, queries }) => !["direct-dial", "proxy-exit"].includes(name) && queries.some(({ domain, type }) => domain === test.domain && type === 1)).map(({ name }) => name);
      const evidence = { format, domain: test.domain, response: result.result.stdout, elapsedMs, dns: queried,
        rule: connection.rule, rulePayload: connection.rulePayload, chains: connection.chains };
      console.log(JSON.stringify(evidence));
      assert.equal(result.result.stdout, test.marker, `${test.domain}: actual HTTP exit differs from expected ${test.marker}`);
      assert.equal(connection.rule, test.rule, `${test.domain}: wrong native rule`);
      if (test.payload) assert.equal(connection.rulePayload, test.payload);
      assert.deepEqual([...new Set(queried.map((name) => name === "domestic-secondary" ? "domestic" : name))], test.dns, `${test.domain}: wrong native DNS path`);
      if (test.secondaryRequired) assert.ok(queried.includes("domestic-secondary"), "Primary DNS failure must be recovered by the second resolver");
      if (test.delegated) {
        assert.deepEqual(delegatedRequests, [{ authority: `${test.domain}:${targetPort}`, hostname: test.domain, address: "127.0.0.1" }]);
        assert.ok(proxyResolver.queries.some(({ domain, type }) => domain === test.domain && type === 1), "Proxy must independently resolve the original hostname");
        assert.deepEqual(originRequests, [{ host: `${test.domain}:${targetPort}`, path: "/probe", exit: "PROXY" }]);
        console.log(JSON.stringify({ format, phase: "dns-timeout-hostname-delegation", target: test.domain, proxyResolution: "127.0.0.1", originReached: true,
          limitation: "Native DNS exhausted its budget; proxy hostname delegation is not a successful remote DNS fallback" }));
      }
      const expectedExit = test.marker === "DIRECT" ? "DIRECT" : test.marker === "AI" ? aiProxy.name : primary.name;
      assert.equal(connection.chains[0], expectedExit, `${test.domain}: wrong actual exit`);
      assert.ok(elapsedMs < (test.budget || 2500), `${test.domain}: ${elapsedMs}ms exceeds ${test.budget || 2500}ms budget`);
    }
    remoteUnavailable = false;
    remoteDelayMs = 0;
    for (const resolver of resolvers) resolver.queries.length = 0;
    const timeoutStarted = performance.now();
    // TXT queries exercise real upstream DNS rather than fake-IP A synthesis
    // or the native fake-IP middleware's empty HTTPS response.
    const timedOut = await wireQuery("domestic-timeout-dns.fixture.invalid", dnsPort, 16, 8000);
    const timeoutMs = Math.round(performance.now() - timeoutStarted);
    console.log(JSON.stringify({ format, phase: "both-domestic-dns-timeout", rcode: timedOut.rcode, elapsedMs: timeoutMs,
      dns: resolvers.filter(({ queries }) => queries.some(({ domain }) => domain === "domestic-timeout-dns.fixture.invalid")).map(({ name }) => name) }));
    assert.equal(timedOut.rcode, 2, "Both domestic resolvers timing out must be reported as SERVFAIL, not fabricated DNS success");
    assert.ok(timeoutMs < 8000, "Native DNS timeout must remain bounded");

    for (const resolver of resolvers) resolver.queries.length = 0;
    const cachedFirst = await api("/dns/query?name=cached-domestic.fixture.invalid&type=A");
    assert.ok(cachedFirst.Answer?.some(({ data }) => data === cn));
    await delay(20);
    const beforeCache = resolvers.map(({ queries }) => queries.length);
    const cachedAgain = await api("/dns/query?name=cached-domestic.fixture.invalid&type=A");
    assert.ok(cachedAgain.Answer?.some(({ data }) => data === cn));
    await delay(20);
    assert.deepEqual(resolvers.map(({ queries }) => queries.length), beforeCache, "Repeated native DNS lookup must reuse its accepted cached result");
    console.log(JSON.stringify({ format, phase: "dns-cache", reused: true, address: cn }));

    for (const resolver of resolvers) resolver.queries.length = 0;
    const ipv6 = await wireQuery("ipv6-disabled.fixture.invalid", dnsPort, 28);
    assert.equal(ipv6.rcode, 0);
    assert.equal(ipv6.count, 0);
    assert.ok(resolvers.every(({ queries }) => !queries.some(({ type }) => type === 28)), "Disabled IPv6 should answer AAAA locally without upstream traffic");
    const https = await wireQuery("https-hint.fixture.invalid", dnsPort, 65);
    console.log(JSON.stringify({ format, phase: "dns-record-types", aaaa: ipv6, https,
      httpsResolvers: resolvers.filter(({ queries }) => queries.some(({ type }) => type === 65)).map(({ name }) => name) }));
    assert.equal(https.rcode, 0);
    assert.equal(https.count, 0, "Generated fake-IP mode must suppress HTTPS answers on the client DNS wire");
    assert.ok(resolvers.every(({ queries }) => !queries.some(({ type }) => type === 65)), "Client HTTPS hints should not bypass fake-IP routing through upstream DNS");
    const httpsApi = await api("/dns/query?name=https-hint.fixture.invalid&type=HTTPS");
    console.log(JSON.stringify({ format, phase: "https-native-resolver-api", status: httpsApi.Status, answers: httpsApi.Answer || [],
      limitation: "The diagnostic resolver API bypasses fake-IP client middleware; CIDR fallback validates address answers, not HTTPS hints" }));
    assert.equal(httpsApi.Status, 0);
    assert.ok(httpsApi.Answer?.some(({ type }) => type === 65));
    await stopCore();
  }
  console.log(JSON.stringify({ passed: true, scope: "native loopback DNS/routing/HTTP regression; not handset or public CDN performance" }));
} finally {
  await stopCore();
  for (const { socket, timers } of resolvers) { for (const timer of timers) clearTimeout(timer); socket.close(); }
  for (const { server, sockets } of proxies) { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); }
  origin.closeAllConnections();
  await new Promise((resolve) => origin.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
