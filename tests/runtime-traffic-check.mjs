import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { buildSingBoxConfig } from "../server/singbox/config.js";
import { buildProtocolClientConfig, defaultProtocolConfigs, normalizeProtocolConfig } from "../server/singbox/protocol-catalog.js";
import { normalizeV2RayUserStats, queryV2RayUserStats } from "../server/usage/v2ray-stats.js";

const run = promisify(execFile);
const binary = process.env.SING_BOX_BIN || "sing-box";
// On macOS the official CGO client supplies Cronet; the server still uses the metered build.
const clientBinary = process.env.SING_BOX_CLIENT_BIN || binary;
const directory = await mkdtemp(join(tmpdir(), "raylink-traffic-"));
const certificatePath = join(directory, "cert.pem");
const keyPath = join(directory, "key.pem");
const payload = "raylink-1.14.2-".repeat(16384);
const user = { email: "traffic@example.com", runtimeName: `rl-user-${randomUUID()}`, runtimeUuid: randomUUID(),
  runtimePassword: randomBytes(16).toString("base64"), state: "active", portalStatus: "active",
  quotaGb: 10, usedGb: 0, expiresAt: "2099-12-31", nodeScope: ["all"] };
const masterPassword = randomBytes(16).toString("base64");
const children = new Set();
const results = [];
const target = createServer((_request, response) => response.end(payload));

async function port() {
  const listener = createTcpServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}
async function start(name, config, executable = binary) {
  const path = join(directory, `${name}.json`);
  await writeFile(path, JSON.stringify(config));
  await run(executable, ["check", "-c", path]);
  const child = spawn(executable, ["run", "-c", path], { stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  child.on("error", (error) => { log += error.message; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (log.includes("sing-box started")) return child;
    if (child.exitCode !== null) break;
    await delay(50);
  }
  throw new Error(`${name} did not start: ${log}`);
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try { await exited; } finally { clearTimeout(timer); children.delete(child); }
}
async function transfer(socksPort) {
  return (await run("curl", ["--silent", "--show-error", "--fail", "--noproxy", "",
    "--max-time", "5", "--socks5-hostname", `127.0.0.1:${socksPort}`,
    `http://127.0.0.1:${target.address().port}/payload`], { maxBuffer: 1024 * 1024 })).stdout;
}

try {
  const details = execFileSync(binary, ["version"], { encoding: "utf8" });
  assert.match(details, /^sing-box version 1\.14\.2\b/);
  assert.match(details, /\bwith_v2ray_api\b/, "traffic checks require the metered Runtime");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certificatePath, "-subj", "/CN=node.example.com",
    "-addext", "subjectAltName=DNS:node.example.com"], { stdio: "ignore" });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  for (const type of ["shadowsocks", "vmess", "vless", "trojan", "anytls", "hysteria", "tuic", "hysteria2", "naive"]) {
    const base = defaultProtocolConfigs().find((entry) => entry.type === type);
    const profile = normalizeProtocolConfig({ ...base, enabled: true, listen: "127.0.0.1", port: await port(),
      tls: ["trojan", "anytls", "hysteria", "tuic", "hysteria2", "naive"].includes(type)
        ? { mode: "certificate", serverName: "node.example.com", certificatePath, keyPath }
        : { mode: "none" } });
    const statsPort = await port();
    const snapshot = { host: { region: "test", runtimeVersion: "1.14.2", buildTags: ["with_v2ray_api"] },
      users: [user], protocols: [profile], masterPassword };
    const serverConfig = buildSingBoxConfig(snapshot);
    serverConfig.experimental.v2ray_api.listen = `127.0.0.1:${statsPort}`;
    const generated = buildProtocolClientConfig({ profiles: [profile], server: "127.0.0.1",
      credential: { ...user, serverPassword: masterPassword } });
    const outbound = generated.outbounds.find((entry) => entry.server_port === profile.port);
    if (outbound.tls) outbound.tls.certificate_path = certificatePath;
    const socksPort = await port();
    const clientConfig = { log: { level: "info" },
      inbounds: [{ type: "socks", listen: "127.0.0.1", listen_port: socksPort }],
      outbounds: [outbound], route: { final: outbound.tag } };
    let server;
    let client;
    try {
      server = await start(`${type}-server`, serverConfig);
      client = await start(`${type}-client`, clientConfig, clientBinary);
      assert.equal(await transfer(socksPort), payload, `${type}: proxy payload must arrive intact`);
      let counters;
      for (let attempt = 0; attempt < 20; attempt++) {
        counters = normalizeV2RayUserStats(await queryV2RayUserStats({ endpoint: `http://127.0.0.1:${statsPort}` }));
        if (counters.some((entry) => entry.name === user.runtimeName && entry.downlinkBytes >= payload.length)) break;
        await delay(50);
      }
      const measured = counters.find((entry) => entry.name === user.runtimeName);
      assert.ok(measured?.uplinkBytes > 0, `${type}: upload must be charged to the User`);
      assert.ok(measured?.downlinkBytes >= payload.length, `${type}: download must be charged to the User`);
      assert.ok(!counters.some((entry) => entry.name === "raylink-probe@internal"));
      // Publish the same entitlement as disabled, then force a fresh client connection.
      await stop(client);
      await stop(server);
      const revoked = buildSingBoxConfig({ ...snapshot, users: [{ ...user, state: "disabled" }] });
      revoked.experimental.v2ray_api.listen = `127.0.0.1:${statsPort}`;
      server = await start(`${type}-revoked`, revoked);
      client = await start(`${type}-revoked-client`, clientConfig, clientBinary);
      await assert.rejects(() => transfer(socksPort), `${type}: disabled User must lose access`);
      results.push({ protocol: type, bytes: payload.length, metered: true, revoked: true });
      process.stdout.write(`${JSON.stringify(results.at(-1))}\n`);
    } finally { await stop(client); await stop(server); }
  }
  process.stdout.write(`${JSON.stringify({ runtime: "1.14.2", protocolsPassed: results.length })}\n`);
} finally {
  await Promise.all([...children].map(stop));
  await new Promise((resolve) => target.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
