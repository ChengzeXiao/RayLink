// Native smart-routing behavior using the public subscription generator.
// Full inline providers/routing rules stay intact. Only DNS/proxy endpoints,
// listener ports and DNS answer mode are adapted to isolated loopback fixtures.
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
import { buildSubscriptionArtifact } from "../server/subscriptions/formats.js";

const run = promisify(execFile);
const binary = process.env.MIHOMO_BIN || "mihomo";
const directory = await mkdtemp(join(tmpdir(), "raylink-mihomo-smart-"));
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function unusedPort() {
  const server = createTcpServer(); const port = await listen(server);
  await new Promise((resolve) => server.close(resolve)); return port;
}
function resolver(name, address) {
  const socket = createSocket("udp4"); const queries = [];
  socket.on("message", (query, peer) => {
    let end = 12; const labels = [];
    while (query[end]) { const n = query[end++]; labels.push(query.toString("ascii", end, end + n)); end += n; }
    const isA = query.readUInt16BE(end + 1) === 1; end += 5;
    queries.push(labels.join("."));
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(isA ? 1 : 0, 6);
    header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, ...address]);
    socket.send(Buffer.concat([header, query.subarray(12, end), ...(isA ? [answer] : [])]), peer.port, peer.address);
  });
  return { name, socket, queries, address: address.join(".") };
}
function proxy(marker) {
  const sockets = new Set();
  const server = createServer((_req, response) => response.end(marker));
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("connect", (_req, socket) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () => socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${marker.length}\r\nConnection: close\r\n\r\n${marker}`));
  });
  return { server, sockets };
}
const resolvers = [resolver("domestic", [127, 0, 0, 1]), resolver("remote", [203, 0, 113, 2]), resolver("ai", [203, 0, 113, 3])];
const primary = proxy("PROXY"); const ai = proxy("AI");
const origin = createServer((_req, response) => response.end("DIRECT"));
let child; let logs = "";
async function dnsQuery(domain, port) {
  const client = createSocket("udp4");
  const header = Buffer.alloc(12); header.writeUInt16BE(0x4321, 0); header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4);
  const question = Buffer.concat([...domain.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0, 0, 1, 0, 1])]);
  try {
    const response = once(client, "message");
    client.send(Buffer.concat([header, question]), port, "127.0.0.1");
    const [answer] = await Promise.race([response, delay(4000).then(() => { throw new Error(`DNS timeout: ${domain}`); })]);
    assert.equal(answer.readUInt16BE(2) & 15, 0, `DNS failed: ${domain}`);
  } finally { client.close(); }
}
try {
  await run(binary, ["-v"]);
  const originPort = await listen(origin); const primaryPort = await listen(primary.server); const aiPort = await listen(ai.server);
  for (const resolver of resolvers) { resolver.socket.bind(0, "127.0.0.1"); await once(resolver.socket, "listening"); }
  const mixedPort = await unusedPort(); const dnsPort = await unusedPort(); const controllerPort = await unusedPort();
  const outbound = (tag) => ({ type: "vless", tag, server: "127.0.0.1", server_port: 443, uuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d" });
  const { body } = buildSubscriptionArtifact({ format: "mihomo", routePolicy: { mode: "smart" }, singBoxConfig: { outbounds: [
    outbound("tcp-primary"), outbound("tcp-ai"),
    { type: "urltest", tag: "raylink-tcp", outbounds: ["tcp-primary", "tcp-ai"] }
  ] } });
  const dnsEndpoint = (name) => `udp://127.0.0.1:${resolvers.find((resolver) => resolver.name === name).socket.address().port}#DIRECT`;
  let yaml = body.replace("mixed-port: 7890", `mixed-port: ${mixedPort}\nexternal-controller: "127.0.0.1:${controllerPort}"`)
    .replace('log-level: "info"', 'log-level: "debug"')
    .replace('  enhanced-mode: "fake-ip"', `  enhanced-mode: "redir-host"\n  listen: "127.0.0.1:${dnsPort}"`)
    .replaceAll("https://223.5.5.5/dns-query", dnsEndpoint("domestic"))
    .replaceAll("https://1.1.1.1/dns-query#AI 网站代理", dnsEndpoint("ai"))
    .replaceAll("https://1.1.1.1/dns-query#RayLink 代理", dnsEndpoint("remote"));
  const start = yaml.indexOf("\nproxies:\n"); const end = yaml.indexOf("\nproxy-groups:\n", start);
  assert.ok(start > 0 && end > start);
  yaml = yaml.slice(0, start) + `\nproxies:\n  - name: "tcp-primary"\n    type: http\n    server: 127.0.0.1\n    port: ${primaryPort}\n  - name: "tcp-ai"\n    type: http\n    server: 127.0.0.1\n    port: ${aiPort}\n` + yaml.slice(end);
  if (process.argv.includes("--negative-control-cn-dns")) {
    // Deliberately regress DNS classification while leaving route rules intact.
    yaml = yaml.replace(`"rule-set:raylink-cn-domain":\n      - "${dnsEndpoint("domestic")}"`, `"rule-set:raylink-cn-domain":\n      - "${dnsEndpoint("remote")}"`);
  }
  const path = join(directory, "config.yaml"); await writeFile(path, yaml);
  await run(binary, ["-t", "-d", directory, "-f", path]);
  child = spawn(binary, ["-d", directory, "-f", path], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => { logs += data; }); child.stderr.on("data", (data) => { logs += data; });
  for (let i = 0; i < 200 && !logs.includes("proxy listening at") && child.exitCode === null; i++) await delay(25);
  assert.ok(logs.includes("proxy listening at"), logs);
  const selected = await fetch(`http://127.0.0.1:${controllerPort}/proxies/${encodeURIComponent("AI 网站代理")}`, { method: "PUT", body: JSON.stringify({ name: "tcp-ai" }), headers: { "content-type": "application/json" } });
  assert.equal(selected.status, 204);
  for (const [domain, expectedDns, expectedRoute] of [
    ["a1.mzstatic.com", "domestic", "DIRECT"],
    ["blog.csdn.net", "domestic", "DIRECT"],
    ["www.alibaba", "domestic", "DIRECT"],
    ["alibaba", "remote", "PROXY"],
    ["google.com", "remote", "PROXY"],
    ["chatgpt.com", "ai", "AI"]
  ]) {
    for (const resolver of resolvers) resolver.queries.length = 0;
    await dnsQuery(domain, dnsPort);
    assert.ok(resolvers.find((resolver) => resolver.name === expectedDns).queries.includes(domain), `${domain}: wrong DNS upstream\n${JSON.stringify(resolvers.map(({ name, queries }) => ({ name, queries })))}`);
    for (const resolver of resolvers.filter((resolver) => resolver.name !== expectedDns)) assert.ok(!resolver.queries.includes(domain), `${domain} also queried through ${resolver.name}`);
    const { stdout } = await run("curl", ["--silent", "--show-error", "--fail", "--max-time", "5", "--noproxy", "", "--socks5-hostname", `127.0.0.1:${mixedPort}`, `http://${domain}:${originPort}/`]);
    assert.equal(stdout, expectedRoute, `${domain}: wrong route\n${logs.slice(-3000)}`);
    console.log(`${domain}: DNS=${expectedDns}, route=${expectedRoute}`);
  }
  assert.match(logs, /RuleSet\(raylink-cn-domain\).*DIRECT/);
  console.log("complete inline China provider drives both native DNS policy and SOCKS routing");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await exited; clearTimeout(timer); }
  for (const resolver of resolvers) { try { resolver.socket.close(); } catch {} }
  for (const item of [primary, ai]) for (const socket of item.sockets) socket.destroy();
  origin.closeAllConnections();
  await Promise.all([origin, primary.server, ai.server].map((server) => new Promise((resolve) => server.close(resolve))));
  await rm(directory, { recursive: true, force: true });
}
