// Isolated native regression: no residential provider, AI account or public
// target is contacted. Real sing-box transports connect local proxy fixtures.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect, createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildSingBoxConfig } from "../server/singbox/config.js";
import { buildProtocolClientConfig, defaultProtocolConfigs } from "../server/singbox/protocol-catalog.js";
const run = (binary, args, options = {}) => promisify(execFile)(binary, args, { timeout: 10000, ...options });
const binary = process.env.SING_BOX_BIN || "sing-box";
const directory = await mkdtemp(join(tmpdir(), "raylink-ai-upstream-"));
const allSockets = new Set(), servers = new Set(), children = new Set(), udpSockets = new Set();
const credential = { email: "egress-fixture@example.invalid", runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d", runtimePassword: "native-fixture-password" };
const ordinaryDomains = ["www.google.com", "google.com", "accounts.google.com", "mail.google.com", "gmail.com", "youtube.com", "www.youtube.com", "ordinary.fixture.invalid", "challenges.cloudflare.com", "hagen.challenges.cloudflare.com", "cdn.workos.com", "forwarder.workos.com", "setup.workos.com", "images.workoscdn.com", "workos.imgix.net"];
async function listen(server) {
  servers.add(server);
  server.on("connection", socket => { allSockets.add(socket); socket.on("error", () => {}); socket.on("close", () => allSockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port;
}
async function unusedPort() { const server = tcpServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function stop(runtime) {
  if (runtime?.child.exitCode === null && runtime.child.signalCode === null) { const exited = once(runtime.child, "exit"); runtime.child.kill("SIGTERM"); const timer = setTimeout(() => runtime.child.kill("SIGKILL"), 2000); await exited; clearTimeout(timer); }
}
async function launch(config, name) {
  const path = join(directory, name + ".json"); await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  await run(binary, ["check", "-c", path]);
  const child = spawn(binary, ["run", "-c", path], { stdio: ["ignore", "pipe", "pipe"] });
  const runtime = { child, log: "" }; children.add(runtime);
  child.stdout.on("data", data => { runtime.log = (runtime.log + data).slice(-12000); }); child.stderr.on("data", data => { runtime.log = (runtime.log + data).slice(-12000); });
  for (let i = 0; i < 100 && !runtime.log.includes("sing-box started") && child.exitCode === null; i++) await delay(50);
  assert.ok(runtime.log.includes("sing-box started"), "fixture Runtime failed to start"); return runtime;
}
function forward(state, socket, host, port, head, response) {
  state.destinations.push({ host, port });
  if (!state.healthy) { socket.destroy(); return; }
  const upstream = connect(port === state.tlsTargetPort ? state.residentialTlsPort : state.residentialPort, "127.0.0.1", () => {
    socket.write(response); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy()); socket.on("close", () => upstream.destroy()); upstream.on("close", () => socket.destroy());
}
function socksFixture(state) {
  return tcpServer(socket => {
    let pending = Buffer.alloc(0), phase = "greeting";
    const onData = data => {
      pending = Buffer.concat([pending, data]);
      if (pending.length > 32768) { socket.destroy(); return; }
      if (phase === "greeting") {
        if (pending.length < 2 || pending.length < 2 + pending[1]) return;
        if (pending[0] !== 5 || !pending.subarray(2, 2 + pending[1]).includes(2)) { socket.destroy(); return; }
        pending = pending.subarray(2 + pending[1]); socket.write(Buffer.from([5, 2])); phase = "auth";
      }
      if (phase === "auth") {
        if (pending.length < 2 || pending.length < 3 + pending[1]) return;
        const userLength = pending[1], passLength = pending[2 + userLength];
        if (pending.length < 3 + userLength + passLength) return;
        const allowed = pending[0] === 1 && pending.subarray(2, 2 + userLength).toString() === "fixture"
          && pending.subarray(3 + userLength, 3 + userLength + passLength).toString() === "fixture-secret" && state.authAllowed;
        pending = pending.subarray(3 + userLength + passLength); socket.write(Buffer.from([1, allowed ? 0 : 1]));
        if (!allowed) { socket.end(); return; } phase = "request";
      }
      if (phase === "request") {
        if (pending.length < 5) return;
        if (pending[0] !== 5 || pending[1] !== 1 || ![1, 3].includes(pending[3])) { socket.destroy(); return; }
        const size = pending[3] === 1 ? 10 : 7 + pending[4]; if (pending.length < size) return;
        const host = pending[3] === 1 ? [...pending.subarray(4, 8)].join(".") : pending.subarray(5, 5 + pending[4]).toString();
        const port = pending.readUInt16BE(size - 2); socket.off("data", onData);
        forward(state, socket, host, port, pending.subarray(size), Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      }
    };
    socket.on("data", onData);
  });
}
async function socksUdp(socksPort, domain, targetPort) {
  const socket = connect(socksPort, "127.0.0.1"); allSockets.add(socket); socket.on("error", () => {}); await once(socket, "connect");
  let pending = Buffer.alloc(0), waiter;
  socket.on("data", data => { pending = Buffer.concat([pending, data]); waiter?.(); });
  async function read(length) {
    const deadline = Date.now() + 2000;
    while (pending.length < length && Date.now() < deadline) await Promise.race([new Promise(resolve => { waiter = resolve; }), delay(30)]);
    assert.ok(pending.length >= length, "SOCKS fixture response timed out");
    const result = pending.subarray(0, length); pending = pending.subarray(length); return result;
  }
  socket.write(Buffer.from([5, 1, 0])); assert.equal((await read(2))[1], 0);
  socket.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));
  const header = await read(4); assert.equal(header[1], 0); assert.equal(header[3], 1);
  const bound = await read(6); const port = bound.readUInt16BE(4);
  const udp = createSocket("udp4"); udpSockets.add(udp); udp.bind(0, "127.0.0.1"); await once(udp, "listening");
  const host = Buffer.from(domain), destination = Buffer.alloc(2); destination.writeUInt16BE(targetPort);
  udp.send(Buffer.concat([Buffer.from([0, 0, 0, 3, host.length]), host, destination, Buffer.from("udp-fixture")]), port, "127.0.0.1");
  const received = await Promise.race([once(udp, "message").then(() => true), delay(700).then(() => false)]);
  udp.close(); udpSockets.delete(udp); socket.destroy(); return received;
}
try {
  const version = (await run(binary, ["version"])).stdout.match(/^sing-box version (\S+)/)?.[1]; assert.equal(version, "1.14.2");
  const keyPath = join(directory, "fixture.key"), certificatePath = join(directory, "fixture.crt");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-keyout", keyPath, "-out", certificatePath,
    "-subj", "/CN=upstream.fixture.invalid", "-addext", "subjectAltName=DNS:upstream.fixture.invalid,DNS:node.fixture.invalid,DNS:claude.ai,DNS:ordinary.fixture.invalid,IP:127.0.0.1"]);
  const tlsOptions = { key: await readFile(keyPath), cert: await readFile(certificatePath) };
  for (const type of ["http", "socks5", "https"]) {
    const state = { direct: 0, residential: 0, destinations: [], healthy: true, authAllowed: true };
    const target = createServer((_request, response) => { state.direct++; response.end("DIRECT"); });
    const residential = createServer((_request, response) => { state.residential++; response.end("RESIDENTIAL"); });
    const tlsTarget = httpsServer(tlsOptions, (_request, response) => { state.direct++; response.end("DIRECT"); });
    const residentialTls = httpsServer(tlsOptions, (_request, response) => { state.residential++; response.end("RESIDENTIAL"); });
    const targetPort = await listen(target); state.residentialPort = await listen(residential);
    state.tlsTargetPort = await listen(tlsTarget); state.residentialTlsPort = await listen(residentialTls);
    const proxy = type === "socks5" ? socksFixture(state) : type === "https" ? httpsServer(tlsOptions) : createServer();
    if (type !== "socks5") proxy.on("connect", (request, socket, head) => {
      if (!state.authAllowed || request.headers["proxy-authorization"] !== "Basic " + Buffer.from("fixture:fixture-secret").toString("base64")) { socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"); return; }
      const destination = new URL("http://" + request.url); forward(state, socket, destination.hostname, Number(destination.port), head, "HTTP/1.1 200 Connection Established\r\n\r\n");
    });
    const proxyPort = await listen(proxy), socksPort = await unusedPort();
    const profiles = [];
    for (const protocol of ["vless", "tuic", "hysteria2"]) profiles.push({ ...defaultProtocolConfigs().find(item => item.type === protocol), enabled: true, port: await unusedPort(),
      tls: protocol === "vless" ? { mode: "none" } : { mode: "certificate", serverName: "node.fixture.invalid", certificatePath, keyPath } });
    const config = buildSingBoxConfig({ host: { id: "local", kind: "local", runtimeVersion: version, region: "test" },
      users: [{ ...credential, state: "active", portalStatus: "active", usedGb: 0, quotaGb: 10, expiresAt: "2099-01-01", nodeScope: ["all"] }],
      protocols: profiles, masterPassword: "AAAAAAAAAAAAAAAAAAAAAA==",
      aiUpstream: { enabled: true, hostId: "local", type, server: "upstream.fixture.invalid", port: proxyPort, username: "fixture", password: "fixture-secret", tlsServerName: "upstream.fixture.invalid", revision: 1 } });
    const productionPath = join(directory, type + "-production.json"); await writeFile(productionPath, JSON.stringify(config), { mode: 0o600 });
    await run(binary, ["check", "-c", productionPath]);
    const domains = ["claude.ai", "api.openai.com", "gemini.google.com", "upstream.fixture.invalid", ...ordinaryDomains];
    // Only environment fixtures change: DNS answers and bind addresses. Native
    // server routing/outbounds and each public protocol's user identity stay intact.
    config.dns.servers = config.dns.servers.map(({ tag }) => ({ type: "hosts", tag, predefined: Object.fromEntries(domains.map(domain => [domain, ["127.0.0.1"]])) }));
    config.inbounds = config.inbounds.map(inbound => ({ ...inbound, listen: "127.0.0.1" }));
    config.inbounds.push({ type: "socks", tag: "fixture-entry", listen: "127.0.0.1", listen_port: socksPort });
    let runtime = await launch(config, type);
    const request = async (domain, port = socksPort, tls = false, numeric = false) => (await run("curl", ["--silent", "--show-error", "--fail", "--noproxy", "", "--max-time", "5",
      numeric ? "--socks5" : "--socks5-hostname", `127.0.0.1:${port}`, ...(tls ? ["--cacert", certificatePath] : []),
      ...(numeric ? ["--resolve", `${domain}:${state.tlsTargetPort}:127.0.0.1`] : []), `${tls ? "https" : "http"}://${domain}:${tls ? state.tlsTargetPort : targetPort}/`], { timeout: 7000 })).stdout;
    if (type === "https") {
      const directBefore = state.direct; await assert.rejects(() => request("claude.ai")); assert.equal(state.direct, directBefore, "untrusted HTTPS proxy must not fall back direct");
      assert.equal(await request("www.google.com"), "DIRECT"); await stop(runtime);
      config.outbounds.find(item => item.tag === "ai-residential").tls.certificate_path = certificatePath;
      runtime = await launch(config, type + "-trusted");
    }
    for (const domain of ["claude.ai", "api.openai.com", "gemini.google.com"]) assert.equal(await request(domain), "RESIDENTIAL", `${type}: ${domain} must reach residential upstream`);
    assert.ok(state.destinations.some(value => value.host === "claude.ai" && value.port === targetPort), "upstream must receive original domain");
    for (const domain of ordinaryDomains) assert.equal(await request(domain), "DIRECT", `${domain} must retain ordinary egress`);
    assert.equal(await request("127.0.0.1"), "DIRECT", "IP-only ordinary traffic must not be swept into residential egress");
    assert.equal(await request("claude.ai", socksPort, true, true), "RESIDENTIAL", "IP destination with visible AI TLS SNI must be recognized");
    assert.equal(await request("ordinary.fixture.invalid", socksPort, true, true), "DIRECT", "visible ordinary TLS SNI must stay direct");
    const udp = createSocket("udp4"); udpSockets.add(udp); let udpDirect = 0;
    udp.on("message", (message, remote) => { udpDirect++; udp.send(message, remote.port, remote.address); });
    udp.bind(0, "127.0.0.1"); await once(udp, "listening");
    assert.equal(await socksUdp(socksPort, "claude.ai", udp.address().port), false, "AI UDP must be rejected");
    assert.equal(udpDirect, 0, "AI UDP must not leak direct");
    assert.equal(await socksUdp(socksPort, "ordinary.fixture.invalid", udp.address().port), true, "ordinary UDP remains direct");
    udp.close(); udpSockets.delete(udp);
    for (const profile of profiles) {
      const compiled = buildProtocolClientConfig({ profiles: [profile], credential, server: "127.0.0.1" });
      const outbound = compiled.outbounds.find(item => item.type === profile.type);
      if (outbound.tls) { outbound.tls.certificate_path = certificatePath; delete outbound.tls.insecure; }
      const clientPort = await unusedPort();
      const clientConfig = profile.type === "vless" ? compiled : { outbounds: [outbound], route: { final: outbound.tag } };
      clientConfig.inbounds = [{ type: "socks", listen: "127.0.0.1", listen_port: clientPort }];
      if (clientConfig.dns) {
        clientConfig.dns.servers = clientConfig.dns.servers.map(({ tag }) => ({ type: "hosts", tag,
          predefined: Object.fromEntries(domains.map(domain => [domain, ["127.0.0.1"]])) }));
        clientConfig.experimental.cache_file.path = join(directory, type + "-client-cache.db");
        for (const group of clientConfig.outbounds.filter(item => item.type === "urltest")) group.url = `http://ordinary.fixture.invalid:${targetPort}/`;
      }
      const client = await launch(clientConfig, type + "-" + profile.type);
      const beforeClient = state.destinations.length;
      assert.equal(await request("claude.ai", clientPort), "RESIDENTIAL", `${profile.type} must carry TCP requests through residential upstream`);
      assert.ok(state.destinations.slice(beforeClient).some(value => value.host === "claude.ai" && value.port === targetPort), "full client routing must retain original AI destination domain");
      assert.equal(await request("www.google.com", clientPort), "DIRECT");
      await stop(client);
    }
    const directBeforeFailure = state.direct; state.healthy = false;
    await assert.rejects(() => request("claude.ai")); assert.equal(state.direct, directBeforeFailure, "upstream failure must never retry AI directly");
    assert.equal(await request("www.google.com"), "DIRECT", "ordinary browsing survives residential failure");
    state.healthy = true; state.authAllowed = false; const directBeforeAuth = state.direct;
    await assert.rejects(() => request("claude.ai")); assert.equal(state.direct, directBeforeAuth, "upstream authentication failure must not fall back direct");
    await stop(runtime);
    console.log(JSON.stringify({ core: version, upstream: type, aiResidential: true, originalDomainPreserved: true, googleAndOrdinaryDirect: true,
      sharedIdentityAndChallengeDirect: true, visibleAiSniRecognized: true, aiUdpRejected: true, ordinaryUdpDirect: true,
      tcpViaRealInboundProtocols: profiles.map(item => item.type), upstreamFailureClosed: true, authenticationFailureClosed: true,
      generatedClientDomainPreservation: true,
      upstreamEndpointBootstrap: true,
      ...(type === "https" ? { untrustedProxyCertificateRejected: true, explicitFixtureCaVerified: true } : {}), realResidentialProviderTested: false }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  for (const runtime of children) await stop(runtime);
  for (const socket of allSockets) socket.destroy();
  for (const socket of udpSockets) socket.close();
  await Promise.all([...servers].filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
  await rm(directory, { recursive: true, force: true });
}
