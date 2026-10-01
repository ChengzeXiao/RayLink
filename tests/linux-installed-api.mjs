// Exercises the installed, sandboxed systemd services through real HTTPS.
// Invoked only by linux-install-smoke.sh on a disposable Linux VM.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { request } from "node:https";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

assert.equal(process.env.RAYLINK_DISPOSABLE_SYSTEM, "1");
assert.equal(process.platform, "linux");
const run = promisify(execFile);
const ca = await readFile("/etc/caddy/raylink/control-plane.crt");
const identity = JSON.parse(await readFile("/etc/raylink/initial-login.json", "utf8"));
let cookie;
async function api(path, { method = "GET", body, headers = {}, status = 200 } = {}) {
  const result = await new Promise((resolve, reject) => {
    const outgoing = request(new URL(path, identity.origin), {
      method, ca, signal: AbortSignal.timeout(60_000),
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
    });
    outgoing.on("error", reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
  // Do not include API bodies: they can contain credentials or subscription URLs.
  assert.equal(result.status, status, `${method} ${path.split("?")[0].replace(/\/sub\/.*/, "/sub/[redacted]")}: unexpected HTTP status`);
  const json = String(result.headers["content-type"]).includes("text/event-stream")
    ? result.text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n")
    : result.text;
  return { ...result, value: json ? JSON.parse(json) : null };
}
const login = await api("/api/auth/login", { method: "POST", body: identity.admin });
cookie = login.headers["set-cookie"][0].split(";")[0];
const bootstrap = (await api("/api/bootstrap")).value;
assert.equal(bootstrap.runtime.mode, "systemd");
assert.equal(bootstrap.runtime.state, "running");
assert.equal(bootstrap.runtimeSetup.ready, true);
assert.equal(bootstrap.installation.version, "1.14.2");
assert.ok(bootstrap.installation.tags.includes("with_v2ray_api"));
const kernelBbr = (await run("sysctl", ["-n", "net.ipv4.tcp_congestion_control"])).stdout.trim();
const kernelQdisc = (await run("sysctl", ["-n", "net.core.default_qdisc"])).stdout.trim();
assert.equal(bootstrap.bbr.congestionControl, kernelBbr);
assert.equal(bootstrap.bbr.qdisc, kernelQdisc);
if (bootstrap.bbr.status === "enabled") { assert.equal(kernelBbr, "bbr"); assert.equal(kernelQdisc, "fq"); }
if (process.argv.includes("--verify-preserved")) {
  assert.ok(bootstrap.users.some(user => user.email === "release-smoke@example.test" && user.state === "disabled"));
  console.log(JSON.stringify({ installedService: "running", userAndCredentialsPreserved: true }));
} else {
  assert.equal(bootstrap.users.length, 0);
  const user = (await api("/api/users", { method: "POST", status: 201, body: {
    name: "Release QA", email: "release-smoke@example.test", password: `Qa9!${randomBytes(20).toString("hex")}`,
    quotaGb: 10, nodeScope: ["all"], state: "active", portalStatus: "active", expiresAt: "2099-01-01"
  } })).value;
  assert.equal(user.runtimeSync.status, "published");
  const subscription = (await api(`/api/users/${user.id}/subscription/rotate`, { method: "POST", status: 201 })).value;
  const config = (await api(`${new URL(subscription.subscriptionUrl).pathname}?format=sing-box`)).value;
  const outbound = config.outbounds.find(entry => entry.type === "shadowsocks");
  assert.ok(outbound, "new user must receive the default Shadowsocks Host");
  assert.ok(config.route.rule_set.every(entry => entry.type === "inline"), "IP self-signed control plane must not block client startup on TLS rule downloads");
  const directory = await mkdtemp(join(tmpdir(), "raylink-installed-client-"));
  let child;
  const payload = "real-systemd-shadowsocks\n".repeat(16384);
  const target = createServer((_request, response) => response.end(payload));
  async function port() { const server = tcpServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value; }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, "exit"); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await ended; } finally { clearTimeout(timer); child = null; }
  }
  async function start(configuration) {
    const path = join(directory, "client.json"); await writeFile(path, JSON.stringify(configuration), { mode: 0o600 });
    child = spawn("/usr/local/bin/raylink-sing-box", ["run", "-c", path], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
    for (let i = 0; i < 200; i++) {
      if (log.includes("sing-box started")) return;
      assert.equal(child.exitCode, null, "generated client failed to start; inspect the isolated runner");
      await delay(50);
    }
    throw new Error("generated client did not become ready");
  }
  try {
    const socksPort = await port();
    // Keep all generated DNS, routing and outbounds. Avoid changing the VM's TUN routes.
    config.inbounds = [{ type: "socks", listen: "127.0.0.1", listen_port: socksPort }];
    config.experimental.cache_file.path = join(directory, "cache.db");
    await start(config); await stop();
    target.listen(0, "127.0.0.1"); await once(target, "listening");
    const transferConfig = { log: { level: "info" }, inbounds: config.inbounds, outbounds: [outbound], route: { final: outbound.tag } };
    await start(transferConfig);
    const transfer = () => run("curl", ["--silent", "--show-error", "--fail", "--noproxy", "", "--max-time", "5", "--socks5-hostname", `127.0.0.1:${socksPort}`, `http://127.0.0.1:${target.address().port}`], { maxBuffer: 1024 * 1024 });
    assert.equal((await transfer()).stdout, payload);
    let measured = false;
    for (let i = 0; i < 40; i++) {
      const snapshot = (await api("/api/bootstrap")).value;
      if (snapshot.users.find(entry => entry.id === user.id)?.usedGb * (1024 ** 3) >= Buffer.byteLength(payload)) { measured = true; break; }
      await delay(1000);
    }
    assert.equal(measured, true, "the installed service must charge traffic to its User");
    await api(`/api/users/${user.id}`, { method: "PATCH", body: { state: "disabled" } });
    await stop(); await start(transferConfig);
    await assert.rejects(transfer, "disabled User must lose access through the real service");
    console.log(JSON.stringify({ installedService: "running", defaultProtocol: "shadowsocks", fullClientColdStart: true, bytes: Buffer.byteLength(payload), metered: true, revoked: true, bbr: bootstrap.bbr.status }));
  } finally { await stop(); await new Promise(resolve => target.close(resolve)); await rm(directory, { recursive: true, force: true }); }
  const token = (await api("/api/mcp/tokens", { method: "POST", status: 201, body: { name: "Release QA", scopes: ["read"], expiresInDays: 1 } })).value;
  const headers = { authorization: `Bearer ${token.token}`, accept: "application/json, text/event-stream" };
  const initialized = await api("/mcp", { method: "POST", headers, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "release-smoke", version: "1.0.0" } } } });
  assert.ok(initialized.value.result?.protocolVersion);
  const listed = (await api("/mcp", { method: "POST", headers: { ...headers, "mcp-protocol-version": initialized.value.result.protocolVersion }, body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } })).value;
  assert.ok(listed.result.tools.some(tool => tool.name === "system_overview"));
  assert.ok(!listed.result.tools.some(tool => tool.name === "users_create"));
  await api(`/api/mcp/tokens/${token.id}`, { method: "DELETE" });
  await api("/mcp", { method: "POST", headers, body: {}, status: 401 });
  console.log(JSON.stringify({ mcpHttpsHandshake: true, tokenScope: true, tokenRevocation: true }));
}
await api("/api/auth/logout", { method: "POST" });
