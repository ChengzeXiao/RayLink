import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { completeControlPlaneSetup } from "../deploy/complete-control-plane-setup.mjs";
import { createRayLinkApp } from "../server/app.js";
import { hashSessionSecret } from "../server/security.js";

test("automatic setup CLI executes through a symbolic link instead of silently skipping initialization", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-auto-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, "setup.mjs");
  await symlink(fileURLToPath(new URL("../deploy/complete-control-plane-setup.mjs", import.meta.url)), entry);
  await assert.rejects(promisify(execFile)(process.execPath, [entry], { env: {} }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /RayLink 自动初始化失败/);
    return true;
  });
});

async function fixture(t, { runtimeState = "running", domain } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-auto-initialize-"));
  const credentialsPath = join(directory, "initial-login.json");
  let setupState = "SETUP_PENDING";
  let initializedAdmin;
  let completions = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    let payload;
    let code = 200;
    if (request.url === "/api/setup/status") payload = { state: setupState };
    else if (request.url === "/api/setup/complete") {
      assert.equal(request.headers.host, "192.0.2.5");
      assert.equal(request.headers["x-forwarded-proto"], "https");
      assert.equal(body.token, "fixture-one-time-setup");
      assert.equal(body.access.canonicalOrigin, domain ? `https://${domain}` : "https://192.0.2.5");
      assert.equal(body.access.subscriptionOrigin, domain ? `https://${domain}` : "https://192.0.2.5");
      assert.equal(body.runtime.address, "192.0.2.5");
      assert.equal(body.certificate.mode, domain ? "caddy-auto" : "ip-self-signed");
      if (domain) assert.equal(body.certificate.email, "ops@example.com");
      assert.deepEqual(body.admin, JSON.parse(await readFile(credentialsPath, "utf8")).admin);
      setupState = "READY";
      initializedAdmin = body.admin;
      completions += 1;
      code = 201;
      payload = { state: "READY" };
    } else if (request.url === "/api/auth/login") {
      assert.deepEqual(body, initializedAdmin);
      response.setHeader("set-cookie", "raylink-session=fixture-session; Secure; HttpOnly");
      payload = { username: body.username };
    } else if (request.url === "/api/bootstrap") {
      assert.equal(request.headers.cookie, "raylink-session=fixture-session");
      payload = { runtime: { state: runtimeState, mode: "systemd" }, runtimeSetup: { warnings: [] } };
    } else if (request.url === "/api/auth/logout") payload = { ok: true };
    else { code = 404; payload = {}; }
    response.writeHead(code, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return {
    options: {
      publicOrigin: "https://192.0.2.5", setupToken: "fixture-one-time-setup", credentialsPath,
      apiOrigin: `http://127.0.0.1:${server.address().port}`, healthTimeoutMs: 1000,
      ...(domain ? { domain, acmeEmail: "ops@example.com" } : {})
    },
    credentialsPath, completionCount: () => completions
  };
}

test("first installation configures the real setup API and verifies an authenticated running Runtime", async (t) => {
  const { options, credentialsPath, completionCount } = await fixture(t);
  const result = await completeControlPlaneSetup(options);
  const identity = JSON.parse(await readFile(credentialsPath, "utf8"));
  assert.equal(result.ready, true);
  assert.equal(identity.admin.username, "admin");
  assert.ok(identity.admin.password.length >= 32);
  assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
  assert.equal(completionCount(), 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(identity.admin.password));
  assert.doesNotMatch(await readFile(credentialsPath, "utf8"), /fixture-one-time-setup/);
  await completeControlPlaneSetup(options);
  assert.equal(completionCount(), 1, "retrying must not create or reset an administrator");
  assert.deepEqual(JSON.parse(await readFile(credentialsPath, "utf8")), identity);
});

test("headless setup fails if the installed service is stopped even after administrator creation", async (t) => {
  const { options } = await fixture(t, { runtimeState: "stopped" });
  await assert.rejects(completeControlPlaneSetup(options), /Runtime 未确认运行/);
});

test("saved initial credentials are never overwritten when invalid or intended for another control plane", async (t) => {
  const { options, credentialsPath, completionCount } = await fixture(t);
  const previous = JSON.stringify({ origin: "https://192.0.2.99", admin: { username: "existing-admin", password: "existing-long-private-password" } });
  await writeFile(credentialsPath, previous, { mode: 0o600 });
  await assert.rejects(completeControlPlaneSetup(options), /不会覆盖原有凭据/);
  assert.equal(await readFile(credentialsPath, "utf8"), previous);
  assert.equal(completionCount(), 0);
});

test("headless setup refuses non-loopback destinations before disclosing initialization secrets", async () => {
  await assert.rejects(completeControlPlaneSetup({
    publicOrigin: "https://192.0.2.5", setupToken: "private-setup-token",
    credentialsPath: "/unused", apiOrigin: "http://192.0.2.99:4173"
  }), /只允许连接本机回环地址/);
});

test("optional domain initialization keeps the trusted IP request origin and saves the final HTTPS domain", async (t) => {
  const { options, credentialsPath } = await fixture(t, { domain: "panel.example.com" });
  const result = await completeControlPlaneSetup(options);
  assert.equal(result.origin, "https://panel.example.com");
  assert.equal(JSON.parse(await readFile(credentialsPath, "utf8")).origin, "https://panel.example.com");
});

test("the headless helper completes RayLink's real setup, account, and bootstrap routes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-auto-setup-api-"));
  const token = "fixture-initialization-only-token";
  let installed = false;
  let activeConfig;
  const installation = { installed: true, version: "1.14.2", platform: "linux", tags: ["with_v2ray_api"], binaryPath: "/fixture/runtime" };
  const app = await createRayLinkApp({
    dataDir: directory, publicOrigin: "https://192.0.2.5", trustProxy: true,
    runtimeMode: "systemd", runtimePlatform: "linux", seedDemoData: false,
    setupRequired: true, setupTokenHash: hashSessionSecret(token),
    setupTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    adminUsername: "bootstrap-admin", adminPassword: "fixture-bootstrap-password",
    runtimeUpdateCheckIntervalMs: 0, protocolLatencyIntervalMs: 0,
    alertIntervalMs: 0,
    ruleSetCache: { prepare: async () => {}, available: () => false, get: async () => null },
    installer: {
      status: async () => installed ? installation : { installed: false },
      install: async () => { installed = true; return installation; }
    },
    runtimeAdapter: {
      status: async () => ({ mode: "systemd", state: activeConfig ? "running" : "stopped", runtimeVersion: installed ? "1.14.2" : null }),
      publish: async ({ configText }) => { activeConfig = JSON.parse(configText); return { mode: "systemd", validation: "sing-box" }; }
    },
    bbrManager: { inspect: async () => ({ status: "available" }), configure: async () => ({ status: "enabled" }) },
    firewallManager: { open: async () => ({ managed: true, rollback: async () => {} }) },
    portManager: { waitForListening: async ({ port, network }) => {
      assert.ok(activeConfig.inbounds.some((entry) => entry.listen_port === port && entry.network === network));
    } }
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const result = await completeControlPlaneSetup({
    publicOrigin: "https://192.0.2.5", setupToken: token,
    credentialsPath: join(directory, "initial-login.json"),
    apiOrigin: `http://127.0.0.1:${app.server.address().port}`
  });
  assert.equal(result.ready, true);
  assert.equal(app.store.setupStatus().state, "READY");
  assert.equal(app.store.getHost("local").address, "192.0.2.5");
  assert.equal(app.store.listUsers().length, 0);
  assert.equal(app.store.listDeployments()[0].status, "active");
  assert.equal(activeConfig.inbounds[0].type, "shadowsocks");
});
