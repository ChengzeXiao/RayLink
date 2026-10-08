import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { buildSingBoxConfig } from "../server/singbox/config.js";
import { buildProtocolClientConfig, defaultProtocolConfigs, normalizeProtocolConfig } from "../server/singbox/protocol-catalog.js";
import { buildSubscriptionArtifact } from "../server/subscriptions/formats.js";

const run = promisify(execFile);
const singBox = process.env.SING_BOX_BIN || "sing-box";
const mihomo = process.env.MIHOMO_BIN || "mihomo";
const directory = await mkdtemp(join(tmpdir(), "raylink-httpupgrade-"));
const children = [];
const origin = createServer((_request, response) => response.end("httpupgrade-fixture"));
const credential = {
  email: "upgrade-fixture@example.invalid", runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d",
  runtimePassword: "fixture", serverPassword: "AAAAAAAAAAAAAAAAAAAAAA=="
};

async function unusedPort() {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function launch(binary, args, marker) {
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let logs = "";
  child.stdout.on("data", data => { logs = (logs + data).slice(-32768); });
  child.stderr.on("data", data => { logs = (logs + data).slice(-32768); });
  for (let attempt = 0; attempt < 100 && !logs.includes(marker) && child.exitCode === null; attempt++) await delay(50);
  assert.ok(logs.includes(marker), logs);
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
  await exited;
  clearTimeout(timer);
}

try {
  const runtime = (await run(singBox, ["version"])).stdout.match(/^sing-box version (\S+)/)?.[1];
  const clientVersion = (await run(mihomo, ["-v"])).stdout.trim().split("\n")[0];
  assert.match(runtime || "", /^1\.(13|14)\./);
  const certificatePath = join(directory, "certificate.pem");
  const keyPath = join(directory, "private-key.pem");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyPath,
    "-out", certificatePath, "-subj", "/CN=upgrade.fixture.invalid", "-addext", "subjectAltName=DNS:upgrade.fixture.invalid"]);
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const originPort = origin.address().port;
  const scenarios = [
    { type: "vless", transport: "none", format: "mihomo" },
    { type: "vless", transport: "ws", format: "mihomo" },
    ...["mihomo", "mihomo-modern"].flatMap(format => ["vmess", "vless", "trojan"].map(type => ({ type, format, transport: "httpupgrade" })))
  ];
  for (const { type, transport, format } of scenarios) {
    const port = await unusedPort();
    const mixedPort = await unusedPort();
    const profile = normalizeProtocolConfig({ ...defaultProtocolConfigs().find(item => item.type === type),
      enabled: true, port, listen: "127.0.0.1", transport: { type: transport, path: "/fixture" },
      tls: type === "trojan" ? { mode: "certificate", serverName: "upgrade.fixture.invalid", certificatePath, keyPath } : { mode: "none" } });
    const config = buildSingBoxConfig({ host: { kind: "local", runtimeVersion: runtime, region: "test" }, protocols: [profile],
      users: [{ ...credential, state: "active", portalStatus: "active", usedGb: 0, quotaGb: 10, expiresAt: "2099-01-01", nodeScope: ["all"] }],
      masterPassword: credential.serverPassword }, { runtimeDns: { mode: "system" } });
    config.route.rules = [{ action: "route", outbound: "direct", override_address: "127.0.0.1", override_port: originPort }];
    const client = buildProtocolClientConfig({ profiles: [profile], server: "127.0.0.1", credential,
      routePolicy: { mode: "global-proxy" }, probeUrl: `http://192.0.2.1:${originPort}/` });
    let { body } = buildSubscriptionArtifact({ format, singBoxConfig: client, routePolicy: { mode: "global-proxy" } });
    body = body.replace("mixed-port: 7890", `mixed-port: ${mixedPort}`);
    // Only the loopback TLS fixture uses a self-signed certificate. Product
    // exports retain certificate verification, asserted in subscription tests.
    if (type === "trojan") body = body.replaceAll("skip-cert-verify: false", "skip-cert-verify: true");
    const serverPath = join(directory, "server.json");
    const clientPath = join(directory, "client.yaml");
    await writeFile(serverPath, JSON.stringify(config));
    await writeFile(clientPath, body);
    await run(singBox, ["check", "-c", serverPath]);
    await run(mihomo, ["-t", "-d", directory, "-f", clientPath]);
    const server = await launch(singBox, ["run", "-c", serverPath], "sing-box started");
    const core = await launch(mihomo, ["-d", directory, "-f", clientPath], "proxy listening at");
    const response = await run("curl", ["--silent", "--show-error", "--noproxy", "", "--socks5-hostname", `127.0.0.1:${mixedPort}`,
      "--max-time", "5", `http://192.0.2.1:${originPort}/`], { timeout: 7000 });
    assert.equal(response.stdout, "httpupgrade-fixture", `${format} ${type} ${transport} must transfer a real response`);
    await stop(core);
    await stop(server);
    console.log(JSON.stringify({ runtime, clientVersion, format, type, transport, requestSucceeded: true }));
  }
} finally {
  for (const child of children) await stop(child);
  if (origin.listening) await new Promise(resolve => origin.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
