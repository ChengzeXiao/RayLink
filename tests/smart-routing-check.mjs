// Real sing-box routing over loopback. DNS answers and dial endpoints are fixtures;
// rule order, resolve actions and policy selection come from the public generator.
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
import { buildProtocolClientConfig, defaultProtocolConfigs } from "../server/singbox/protocol-catalog.js";

const run = promisify(execFile);
const binary = process.env.SING_BOX_BIN || "sing-box";
const testIpPriority = process.argv.includes("--ip-priority");
const directory = await mkdtemp(join(tmpdir(), "raylink-smart-routing-"));
const origin = createServer((_request, response) => response.end("DIRECT"));
const proxy = createServer((_request, response) => response.end("PROXY"));
const proxyTargets = [];
proxy.on("connect", (request, socket) => {
  proxyTargets.push(request.url);
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nPROXY"));
});
const dns = createSocket("udp4");
const lookups = [];
let rotatingQueries = 0;
dns.on("message", (query, remote) => {
  let cursor = 12;
  const labels = [];
  while (query[cursor]) { const size = query[cursor++]; labels.push(query.toString("ascii", cursor, cursor + size)); cursor += size; }
  const name = labels.join(".");
  const type = query.readUInt16BE(cursor + 1);
  const question = query.subarray(12, cursor + 5);
  lookups.push(name);
  const address = name.startsWith("rotating.")
    ? [192, 0, 2, type === 1 && ++rotatingQueries > 1 ? 30 : 20]
    : name.startsWith("private.") ? [127, 0, 0, 1]
    : name.startsWith("foreign.") ? [203, 0, 113, 20]
      : name.startsWith("blocked.") ? [192, 0, 2, 30]
        : name.startsWith("forced.") ? [192, 0, 2, 40]
          : name === "google.com" ? [192, 0, 2, 50]
            : name === "chatgpt.com" ? [192, 0, 2, 60] : [192, 0, 2, 20];
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(type === 1 ? 1 : 0, 6);
  header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, name.startsWith("rotating.") ? 0 : 10, 0, 4, ...address]);
  dns.send(Buffer.concat([header, question, ...(type === 1 ? [answer] : [])]), remote.port, remote.address);
});
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function unusedPort() {
  const server = createTcpServer(); const port = await listen(server);
  await new Promise((resolve) => server.close(resolve)); return port;
}
let child;
let logs = "";
try {
  assert.match((await run(binary, ["version"])).stdout, /^sing-box version 1\.14\.2\b/);
  const originPort = await listen(origin);
  const proxyPort = await listen(proxy);
  dns.bind(0, "127.0.0.1"); await once(dns, "listening");
  const inboundPort = await unusedPort();
  const config = buildProtocolClientConfig({
    profiles: defaultProtocolConfigs(), server: "127.0.0.1", probeUrl: `http://127.0.0.1:${originPort}/probe`,
    credential: { email: "simulation@example.test", runtimePassword: "AAAAAAAAAAAAAAAAAAAAAA==", serverPassword: "AAAAAAAAAAAAAAAAAAAAAA==" },
    routePolicy: { mode: "smart", rules: [
      { id: "explicit-proxy", match: "domain", value: "forced.example.test", action: "proxy", priority: 1 },
      ...(testIpPriority ? [
        { id: "ip-block", match: "ip_cidr", value: "192.0.2.30/32", action: "block", priority: 2 },
        { id: "lower-domain", match: "domain", value: "blocked.example.test", action: "direct", priority: 3 },
        { id: "rotating-domain", match: "domain", value: "rotating.example.test", action: "proxy", priority: 4 }
      ] : [])
    ] }
  });
  config.log.level = "debug";
  config.inbounds = [{ type: "mixed", tag: "simulation", listen: "127.0.0.1", listen_port: inboundPort }];
  config.dns.servers = config.dns.servers.map(({ tag }) => ({ type: "udp", tag, server: "127.0.0.1", server_port: dns.address().port }));
  config.route.rule_set = [
    { type: "inline", tag: "geosite-geolocation-cn", rules: [{ domain_suffix: ["known.cn"] }] },
    { type: "inline", tag: "geoip-cn", rules: [{ ip_cidr: ["192.0.2.0/24"] }] }
  ];
  // Redirect only the selected direct route to a local HTTP origin, after matching.
  for (const rule of config.route.rules) {
    if (rule.outbound === "direct") Object.assign(rule, { override_address: "127.0.0.1", override_port: originPort });
  }
  config.outbounds = config.outbounds.map((outbound) => outbound.server
    ? { type: "http", tag: outbound.tag, server: "127.0.0.1", server_port: proxyPort } : outbound);
  config.experimental.cache_file.path = join(directory, "cache.db");
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(config));
  await run(binary, ["check", "-c", path]);
  child = spawn(binary, ["run", "-c", path], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => { logs += data; }); child.stderr.on("data", (data) => { logs += data; });
  for (let i = 0; i < 100 && !logs.includes("sing-box started") && child.exitCode === null; i++) await delay(25);
  assert.ok(logs.includes("sing-box started"), logs);
  const request = async (domain) => (await run("curl", ["--silent", "--show-error", "--fail", "--max-time", "8", "--noproxy", "", "--socks5-hostname", `127.0.0.1:${inboundPort}`, `http://${domain}:${originPort}/`])).stdout;
  for (const [domain, expected] of [
    ["unknown.example.test", "DIRECT"], ["private.example.test", "DIRECT"],
    ["foreign.example.test", "PROXY"], ["forced.example.test", "PROXY"],
    ["192.0.2.20", "DIRECT"], ["203.0.113.20", "PROXY"],
    ["api.known.cn", "DIRECT"], ["chatgpt.com", "PROXY"], ["google.com", "PROXY"]
  ]) {
    assert.equal(await request(domain), expected, `${domain}: wrong exit\n${logs}`);
    process.stdout.write(`${domain}: ${expected}\n`);
  }
  assert.ok(lookups.includes("unknown.example.test"), "unknown SOCKS hostname must be resolved for GeoIP matching");
  assert.ok(lookups.includes("api.known.cn"), "known domestic hostname must use its selected DNS policy before direct dialing");
  assert.ok(proxyTargets.includes(`192.0.2.40:${originPort}`), "custom proxy DNS must supply the actual dial address, not just a diagnostic label");
  assert.ok(proxyTargets.includes(`192.0.2.50:${originPort}`), "known overseas DNS must supply the proxy dial address even for a China IP answer");
  if (testIpPriority) {
    // An explicit IP rule must inspect the resolved address first and keep
    // that same address for dialing, including AI targets (DNS-rebind safety).
    assert.ok(proxyTargets.includes(`192.0.2.60:${originPort}`), "custom IP precedence must retain the checked AI dial address");
  } else {
    // The default AI path preserves its hostname for server-side upstream
    // classification and DNS at the chosen exit, rather than resolving early.
    assert.ok(proxyTargets.includes(`chatgpt.com:${originPort}`), "AI proxy requests must retain the original domain");
    assert.ok(!lookups.includes("chatgpt.com"), "default AI routing must not pre-resolve its proxy destination");
  }
  if (testIpPriority) {
    await assert.rejects(request("blocked.example.test"), "higher priority IP block must win over a later domain direct rule");
    assert.match(logs, /192\.0\.2\.30.*reject/, "the rejection must come from the matching IP rule");
    process.stdout.write("IP block before domain direct: REJECT\n");
    assert.equal(await request("rotating.example.test"), "PROXY");
    assert.equal(proxyTargets.at(-1), `192.0.2.20:${originPort}`, "dialing must retain the address checked by the higher priority IP rule despite TTL=0 rotation");
    process.stdout.write("rotating DNS: preserves the checked IP through proxy dialing\n");
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await exited; clearTimeout(timer);
  }
  try { dns.close(); } catch { /* Failed before bind. */ }
  origin.closeAllConnections(); proxy.closeAllConnections();
  await Promise.all([origin, proxy].map((server) => new Promise((resolve) => server.close(resolve))));
  await rm(directory, { recursive: true, force: true });
}
