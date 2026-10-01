import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRayLinkApp } from "../server/app.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

function createTestInstaller() {
  return {
    async status() {
      return {
        installed: true,
        version: "1.14.2",
        platform: "linux",
        architecture: "amd64",
        tags: ["with_utls", "with_acme", "with_quic"],
        binaryPath: "/test/raylink-sing-box"
      };
    },
    async generateRealityKeypair() {
      return { privateKey: "test-private-key", publicKey: "test-public-key" };
    },
    releaseStatus() {
      return null;
    }
  };
}

async function startTestApp(overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-api-"));
  const app = await createRayLinkApp({
    dataDir,
    adminUsername: "admin",
    adminPassword: "Admin@2026",
    publicOrigin: "http://127.0.0.1",
    runtimeMode: "dry-run",
    // Keep mock capabilities independent of whatever Runtime is installed on the developer's PATH.
    singBoxBinary: process.env.SING_BOX_BIN || join(dataDir, "uninstalled-test-runtime"),
    nodeHeartbeatMinIntervalMs: 0,
    runtimeUpdateCheckIntervalMs: 0,
    installer: createTestInstaller(),
    ruleSetCache: {
      prepare: async () => {},
      available: () => false,
      get: async () => null
    },
    endpointResolver: {
      resolve: async ({ fallbackAddress }) => fallbackAddress
        ? { address: fallbackAddress, source: "configured-fallback" }
        : null
    },
    ...overrides
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  return {
    app,
    dataDir,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "Admin@2026" })
  });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie()[0].split(";")[0];
}

async function api(baseUrl, cookie, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      cookie,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
}

async function enableHostShadowsocks(baseUrl, cookie, hostId, port = 8388) {
  const response = await api(
    baseUrl,
    cookie,
    `/api/hosts/${encodeURIComponent(hostId)}/protocols/shadowsocks`,
    {
      method: "PATCH",
      body: JSON.stringify({
        enabled: true,
        listen: "::",
        port,
        tls: { mode: "none" },
        transport: { type: "none" },
        options: {}
      })
    }
  );
  assert.equal(response.status, 200);
}

test("readiness is authenticated, read-only and safe to export", async (t) => {
  const testApp = await startTestApp({ backupIntervalMs: 0, alertIntervalMs: 0 });
  t.after(() => testApp.close());
  assert.equal((await fetch(`${testApp.baseUrl}/api/operations/readiness`)).status, 401);
  const cookie = await login(testApp.baseUrl);
  const before = testApp.app.store.listDeployments().length;
  const response = await api(testApp.baseUrl, cookie, "/api/operations/readiness");
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.schemaVersion, 1);
  assert.notEqual(report.status, "healthy");
  assert.ok(report.checks.some((check) => check.id === "deployment"));
  assert.doesNotMatch(JSON.stringify(report), /runtimePassword|runtimeUuid|privateKey|subscriptionUrl|configPath/);
  assert.equal(testApp.app.store.listDeployments().length, before);
  const backup = await (await api(testApp.baseUrl, cookie, "/api/backups", { method: "POST" })).json();
  const verified = await (await api(testApp.baseUrl, cookie, "/api/operations/readiness")).json();
  assert.equal(verified.checks.find((check) => check.id === "backup").status, "pass");
  await rm(join(testApp.dataDir, "backups", backup.filename));
  const missing = await (await api(testApp.baseUrl, cookie, "/api/operations/readiness")).json();
  assert.equal(missing.checks.find((check) => check.id === "backup").status, "fail");
});

test("shutdown waits for an initial backup including its asynchronous listing phase", async () => {
  let releaseList;
  let markListing;
  let created = false;
  const listingStarted = new Promise((resolve) => { markListing = resolve; });
  const listingGate = new Promise((resolve) => { releaseList = resolve; });
  const testApp = await startTestApp({
    alertIntervalMs: 0, backupStartupDelayMs: 0, backupIntervalMs: 60_000,
    backupManager: {
      async list() { markListing(); await listingGate; return []; },
      async create() {
        testApp.app.store.listUsers(); // Must still be open after list completes.
        created = true;
      }
    }
  });
  await listingStarted;
  let closed = false;
  const closing = testApp.app.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const closedBeforeBackup = closed;
  releaseList();
  await closing;
  await rm(testApp.dataDir, { recursive: true, force: true });
  assert.equal(closedBeforeBackup, false);
  assert.equal(created, true);
});

test("admin can run the one-click protocol activation transaction", async (t) => {
  const calls = [];
  const testApp = await startTestApp({
    protocolActivationManager: {
      enable: async (input) => {
        calls.push(input);
        return {
          profile: { type: input.type, enabled: true, port: 18444 },
          deployment: { id: "deployment-activation", status: "active" },
          activation: { state: "public-ready", port: 18444, network: "tcp" }
        };
      }
    }
  });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const response = await api(
    testApp.baseUrl,
    cookie,
    "/api/hosts/local/protocols/vless/activate",
    { method: "POST" }
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).activation.state, "public-ready");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hostId, "local");
  assert.equal(calls[0].type, "vless");
  assert.ok(calls[0].adminId);
});

test("admin can measure every enabled protocol on one Host", async (t) => {
  const calls = [];
  const testApp = await startTestApp({
    protocolActivationManager: {
      measureHost: async (input) => {
        calls.push(input);
        return {
          hostId: input.hostId,
          checkedAt: "2026-07-28T01:00:00.000Z",
          results: [
            { type: "shadowsocks", status: "available", latencyMs: 38 },
            { type: "hysteria2", status: "timeout", latencyMs: null }
          ]
        };
      }
    }
  });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const response = await api(
    testApp.baseUrl,
    cookie,
    "/api/hosts/local/protocols/latency",
    { method: "POST" }
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results[0].latencyMs, 38);
  assert.equal(body.results[1].status, "timeout");
  assert.deepEqual(calls, [{ hostId: "local" }]);
});

test("automatic protocol sampling also refreshes a pending remote Host", async (t) => {
  const calls = [];
  const testApp = await startTestApp({
    protocolLatencyIntervalMs: 20,
    protocolActivationManager: {
      measureHost: async ({ hostId }) => {
        calls.push(hostId);
        return { hostId, checkedAt: new Date().toISOString(), results: [] };
      }
    }
  });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const created = await (await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "待接入 Host",
      address: "pending.example.com",
      region: "tokyo"
    })
  })).json();

  await new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (!calls.includes(created.host.id)) return;
      clearInterval(poll);
      clearTimeout(timeout);
      resolve();
    }, 10);
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("定时延迟测试未覆盖待接入 Host"));
    }, 1_000);
  });

  assert.ok(calls.includes(created.host.id));
});

test("admin can configure the ACME notification email before one-click TLS activation", async (t) => {
  const installer = {
    async status() {
      return {
        installed: true,
        version: "1.14.2",
        platform: "linux",
        architecture: "amd64",
        tags: ["with_utls", "with_acme", "with_quic"]
      };
    },
    async generateRealityKeypair() {
      return { privateKey: "private-key", publicKey: "public-key" };
    },
    releaseStatus() {
      return null;
    }
  };
  const testApp = await startTestApp({
    installer,
    proxyHost: "node.example.com"
  });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const saved = await api(
    testApp.baseUrl,
    cookie,
    "/api/settings/certificate",
    {
      method: "PATCH",
      body: JSON.stringify({ email: "Ops@Example.COM" })
    }
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    mode: null,
    email: "ops@example.com"
  });

  const bootstrap = await (await api(
    testApp.baseUrl,
    cookie,
    "/api/bootstrap"
  )).json();
  assert.deepEqual(bootstrap.certificate, {
    mode: null,
    email: "ops@example.com"
  });

  const activation = await api(
    testApp.baseUrl,
    cookie,
    "/api/hosts/local/protocols/hysteria2/activate",
    { method: "POST" }
  );
  assert.equal(activation.status, 200);
  const activated = await activation.json();
  assert.equal(activated.profile.tls.mode, "acme");
  assert.equal(activated.profile.tls.acmeEmail, "ops@example.com");
});

test("admin can persist the unified routing policy and bootstrap returns it", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const saved = await api(
    testApp.baseUrl,
    cookie,
    "/api/settings/routing",
    {
      method: "PATCH",
      body: JSON.stringify({
        mode: "smart",
        rules: [{
          match: "domain_suffix",
          value: "work.example",
          action: "direct",
          dns: "domestic",
          priority: 10,
          enabled: true
        }]
      })
    }
  );
  assert.equal(saved.status, 200);
  const policy = await saved.json();
  assert.equal(policy.rules[0].value, "work.example");

  const bootstrap = await (await api(
    testApp.baseUrl,
    cookie,
    "/api/bootstrap"
  )).json();
  assert.deepEqual(bootstrap.routingPolicy, policy);

  const diagnostic = await api(
    testApp.baseUrl,
    cookie,
    "/api/routing/diagnose",
    {
      method: "POST",
      body: JSON.stringify({ domain: "app.work.example" })
    }
  );
  assert.equal(diagnostic.status, 200);
  const result = await diagnostic.json();
  assert.equal(result.source, "custom");
  assert.equal(result.outbound, "direct");
});

test("remote one-click activation automatically retries the next port reported free by its Node", async (t) => {
  const installer = {
    async status() {
      return {
        installed: true,
        version: "1.14.2",
        platform: "linux",
        architecture: "amd64",
        tags: ["with_utls", "with_acme", "with_quic"]
      };
    },
    async generateRealityKeypair() {
      return { privateKey: "private-key", publicKey: "public-key" };
    },
    releaseStatus() {
      return null;
    }
  };
  const testApp = await startTestApp({ installer });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const created = await (await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "远程端口重试节点",
      address: "retry.example.com",
      region: "tokyo"
    })
  })).json();
  const enrolled = await (await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "retry-node",
      platform: "linux",
      architecture: "x64",
      agentVersion: "0.7.0",
      runtimeVersion: "1.14.2",
      buildTags: ["with_utls", "with_acme", "with_quic"]
    })
  })).json();
  const nodeHeaders = {
    authorization: `Bearer ${enrolled.nodeSecret}`,
    "x-raylink-host-id": enrolled.hostId
  };
  const certificateSettings = await api(
    testApp.baseUrl,
    cookie,
    "/api/settings/certificate",
    {
      method: "PATCH",
      body: JSON.stringify({ email: "ops@example.com" })
    }
  );
  assert.equal(certificateSettings.status, 200);

  const activated = await api(
    testApp.baseUrl,
    cookie,
    `/api/hosts/${encodeURIComponent(enrolled.hostId)}/protocols/vless/activate`,
    { method: "POST" }
  );
  assert.equal(activated.status, 202);

  const firstTask = await (await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  })).json();
  assert.equal(firstTask.payload.activation.port, 8444);
  const completion = await fetch(
    `${testApp.baseUrl}/api/node/tasks/${encodeURIComponent(firstTask.id)}/complete`,
    {
      method: "POST",
      headers: { ...nodeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        attempt: firstTask.attempt,
        status: "failed",
        result: {
          code: "PROTOCOL_PORT_OCCUPIED",
          suggestedPort: 8445,
          error: "端口 8444/tcp 已被系统服务占用",
          rolledBack: true
        }
      })
    }
  );
  assert.equal(completion.status, 200);
  assert.equal((await completion.json()).retryQueued, true);

  const secondTask = await (await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  })).json();
  assert.equal(secondTask.payload.activation.port, 8445);
  assert.equal(
    secondTask.payload.protocols.find((profile) => profile.type === "vless").port,
    8445
  );
});

test("authenticated bootstrap returns users with independent entitlements", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());

  const anonymous = await fetch(`${testApp.baseUrl}/api/bootstrap`);
  assert.equal(anonymous.status, 401);

  const cookie = await login(testApp.baseUrl);
  const response = await fetch(`${testApp.baseUrl}/api/bootstrap`, {
    headers: { cookie }
  });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.currentAdmin.username, "admin");
  assert.equal(body.hosts[0].name, "RayLink Runtime");
  assert.equal(body.users.length, 6);
  assert.equal("plans" in body, false);
  const user = body.users.find((candidate) => candidate.email === "lin.zhixia@meridian-log.cn");
  assert.equal(user.quotaGb, 120);
  assert.equal("deviceLimit" in user, false);
  assert.deepEqual(user.nodeScope, ["tokyo", "singapore"]);
  assert.equal("clientFormats" in user, false);
  assert.equal("planId" in user, false);
  assert.equal("passwordHash" in body.users[0], false);
  assert.equal("runtimeCredential" in body.users[0], false);
});

test("admin can log out the current control-plane session", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());

  const firstCookie = await login(testApp.baseUrl);
  const secondCookie = await login(testApp.baseUrl);

  const rejectedOrigin = await api(
    testApp.baseUrl,
    firstCookie,
    "/api/auth/logout",
    {
      method: "POST",
      headers: { origin: "https://attacker.example" }
    }
  );
  assert.equal(rejectedOrigin.status, 403);
  assert.equal(
    (await api(testApp.baseUrl, firstCookie, "/api/bootstrap")).status,
    200
  );

  const logout = await api(testApp.baseUrl, firstCookie, "/api/auth/logout", {
    method: "POST"
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { loggedOut: true });
  const clearedCookie = logout.headers.getSetCookie()[0];
  assert.match(clearedCookie, /raylink_session=;/);
  assert.match(clearedCookie, /Path=\//);
  assert.match(clearedCookie, /HttpOnly/);
  assert.match(clearedCookie, /SameSite=Strict/);
  assert.match(clearedCookie, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  assert.match(clearedCookie, /Max-Age=0/);

  assert.equal(
    (await api(testApp.baseUrl, firstCookie, "/api/bootstrap")).status,
    401
  );
  assert.equal(
    (await api(testApp.baseUrl, secondCookie, "/api/bootstrap")).status,
    200
  );

  const staleLogout = await api(
    testApp.baseUrl,
    "raylink_session=already-expired",
    "/api/auth/logout",
    { method: "POST" }
  );
  assert.equal(staleLogout.status, 200);
  assert.match(staleLogout.headers.getSetCookie()[0], /Max-Age=0/);

  const secureApp = await startTestApp({
    publicOrigin: "https://control.example.com"
  });
  t.after(() => secureApp.close());
  const secureCookie = await login(secureApp.baseUrl);
  const secureLogout = await api(
    secureApp.baseUrl,
    secureCookie,
    "/api/auth/logout",
    { method: "POST" }
  );
  assert.equal(secureLogout.status, 200);
  assert.match(secureLogout.headers.getSetCookie()[0], /Secure/);
});

test("owner manages administrator roles while support and auditor remain isolated", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const ownerCookie = await login(testApp.baseUrl);
  const ownerBootstrap = await (
    await api(testApp.baseUrl, ownerCookie, "/api/bootstrap")
  ).json();
  assert.deepEqual(ownerBootstrap.backups, []);
  const backupResponse = await api(testApp.baseUrl, ownerCookie, "/api/backups", {
    method: "POST"
  });
  assert.equal(backupResponse.status, 201);
  assert.equal((await backupResponse.json()).integrity, "ok");
  const backupList = await (
    await api(testApp.baseUrl, ownerCookie, "/api/backups")
  ).json();
  assert.equal(backupList.backups.length, 1);
  const alerts = await (
    await api(testApp.baseUrl, ownerCookie, "/api/alerts")
  ).json();
  assert.equal(Array.isArray(alerts.alerts), true);
  assert.equal(alerts.delivery.enabled, false);
  const lastOwnerDemotion = await api(
    testApp.baseUrl,
    ownerCookie,
    `/api/admins/${encodeURIComponent(ownerBootstrap.currentAdmin.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ role: "auditor" })
    }
  );
  assert.equal(lastOwnerDemotion.status, 409);
  assert.equal((await lastOwnerDemotion.json()).error.code, "LAST_OWNER_REQUIRED");

  const supportResponse = await api(testApp.baseUrl, ownerCookie, "/api/admins", {
    method: "POST",
    body: JSON.stringify({
      username: "support-one",
      password: "Support@2026!",
      role: "support"
    })
  });
  assert.equal(supportResponse.status, 201);

  const supportLogin = await fetch(`${testApp.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "support-one", password: "Support@2026!" })
  });
  assert.equal(supportLogin.status, 200);
  assert.equal((await supportLogin.clone().json()).currentAdmin.role, "support");
  const supportCookie = supportLogin.headers.getSetCookie()[0].split(";")[0];

  const supportUser = await api(testApp.baseUrl, supportCookie, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "Supported User",
      email: "supported-user@example.com",
      password: "Portal@2026",
      quotaGb: 50,
      nodeScope: ["all"],
      state: "active",
      portalStatus: "active",
      expiresAt: "2030-12-31"
    })
  });
  assert.equal(supportUser.status, 201);

  const forbiddenPublish = await api(
    testApp.baseUrl,
    supportCookie,
    "/api/deployments",
    { method: "POST" }
  );
  assert.equal(forbiddenPublish.status, 403);
  assert.equal((await forbiddenPublish.json()).error.code, "FORBIDDEN");
  assert.equal(
    (await api(testApp.baseUrl, supportCookie, "/api/admins")).status,
    403
  );
  assert.equal(
    (await api(testApp.baseUrl, supportCookie, "/api/backups", {
      method: "POST"
    })).status,
    403
  );

  const auditorResponse = await api(testApp.baseUrl, ownerCookie, "/api/admins", {
    method: "POST",
    body: JSON.stringify({
      username: "auditor-one",
      password: "Auditor@2026!",
      role: "auditor"
    })
  });
  assert.equal(auditorResponse.status, 201);
  const auditorLogin = await fetch(`${testApp.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "auditor-one", password: "Auditor@2026!" })
  });
  const auditorCookie = auditorLogin.headers.getSetCookie()[0].split(";")[0];
  assert.equal((await api(testApp.baseUrl, auditorCookie, "/api/bootstrap")).status, 200);
  assert.equal((await api(testApp.baseUrl, auditorCookie, "/api/operations/readiness")).status, 200);
  assert.equal(
    (await api(testApp.baseUrl, auditorCookie, "/api/users", {
      method: "POST",
      body: JSON.stringify({})
    })).status,
    403
  );

  const auditResponse = await api(testApp.baseUrl, ownerCookie, "/api/audit");
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json();
  assert.ok(audit.events.some((event) => (
    event.actorUsername === "support-one"
    && event.action === "POST /api/users"
  )));
  assert.ok(!audit.events.some((event) => event.action.includes("password")));
});

test("the control plane creates its first scheduled backup shortly after startup", async (t) => {
  let creates = 0;
  const backupManager = {
    async create() {
      creates += 1;
      return {
        filename: "raylink-20260730T000000-12345678.sqlite",
        checksum: "a".repeat(64),
        integrity: "ok"
      };
    },
    async list() {
      return [];
    },
    async verify() {
      return { valid: true };
    }
  };
  const testApp = await startTestApp({
    backupManager,
    backupIntervalMs: 60_000,
    backupStartupDelayMs: 1
  });
  t.after(() => testApp.close());

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(creates, 1);
});

test("production initialization can start without known demo users", async (t) => {
  const testApp = await startTestApp({ seedDemoData: false });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const response = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const body = await response.json();
  assert.deepEqual(body.users, []);
  assert.equal("plans" in body, false);
});

test("empty-database API workflow reaches a multi-Host client configuration", async (t) => {
  const runtimeAdapter = {
    activePath: "/tmp/raylink-workflow-config.json",
    async status() {
      return {
        state: "running",
        mode: "test",
        configPath: this.activePath,
        runtimeVersion: "1.14.2"
      };
    },
    async publish() {
      return this.status();
    }
  };
  const testApp = await startTestApp({
    seedDemoData: false,
    proxyHost: "local.example.com",
    runtimeAdapter
  });
  t.after(() => testApp.close());
  const adminCookie = await login(testApp.baseUrl);

  await enableHostShadowsocks(testApp.baseUrl, adminCookie, "local", 8388);
  const createdHostResponse = await api(testApp.baseUrl, adminCookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "Singapore 01",
      address: "sg.example.com",
      region: "singapore"
    })
  });
  assert.equal(createdHostResponse.status, 201);
  const createdHost = await createdHostResponse.json();

  const enrollResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: createdHost.enrollmentToken,
      hostname: "sg-vps-01",
      platform: "linux",
      architecture: "amd64",
      agentVersion: "0.7.0",
      runtimeVersion: "1.14.2",
      buildTags: ["with_quic", "with_utls", "with_v2ray_api"]
    })
  });
  assert.equal(enrollResponse.status, 201);
  const nodeCredential = await enrollResponse.json();
  await enableHostShadowsocks(
    testApp.baseUrl,
    adminCookie,
    nodeCredential.hostId,
    8388
  );

  const userResponse = await api(testApp.baseUrl, adminCookie, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "Production User",
      email: "production-user@example.com",
      password: "RayLink@2026",
      quotaGb: 100,
      nodeScope: ["all"],
      clientFormats: ["sing-box"],
      state: "active",
      portalStatus: "active",
      expiresAt: "2030-12-31"
    })
  });
  assert.equal(userResponse.status, 201);
  const user = await userResponse.json();
  assert.equal(user.runtimeSync.status, "current");

  const publishResponse = await api(
    testApp.baseUrl,
    adminCookie,
    "/api/deployments",
    { method: "POST" }
  );
  assert.equal(publishResponse.status, 201);
  assert.equal((await publishResponse.json()).remoteQueued, 1);

  const nodeHeaders = {
    authorization: `Bearer ${nodeCredential.nodeSecret}`,
    "x-raylink-host-id": nodeCredential.hostId
  };
  const taskResponse = await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  });
  assert.equal(taskResponse.status, 200);
  const task = await taskResponse.json();
  assert.equal(task.kind, "publish-config");
  const remoteConfig = JSON.parse(task.payload.configText);
  assert.equal(remoteConfig.inbounds[0].users[0].name, "production-user@example.com");

  const completionResponse = await fetch(
    `${testApp.baseUrl}/api/node/tasks/${encodeURIComponent(task.id)}/complete`,
    {
      method: "POST",
      headers: { ...nodeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        attempt: task.attempt,
        status: "succeeded",
        runtimeVersion: "1.14.2",
        validation: "sing-box"
      })
    }
  );
  assert.equal(completionResponse.status, 200);
  const heartbeatResponse = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers: { ...nodeHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      runtimeVersion: "1.14.2",
      buildTags: ["with_quic", "with_utls", "with_v2ray_api"],
      runtimeState: "running",
      telemetry: {
        cpuPercent: 12,
        memoryUsedBytes: 256 * 1024 * 1024,
        memoryTotalBytes: 1024 * 1024 * 1024,
        networkRxBytes: 1_024,
        networkTxBytes: 2_048,
        networkRxBps: 128,
        networkTxBps: 256,
        serviceStatus: "running"
      }
    })
  });
  assert.equal(heartbeatResponse.status, 200);

  const portalLogin = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "production-user@example.com",
      password: "RayLink@2026"
    })
  });
  assert.equal(portalLogin.status, 200);
  const portalCookie = portalLogin.headers.getSetCookie()[0].split(";")[0];
  const clientConfigResponse = await fetch(
    `${testApp.baseUrl}/api/portal/config/sing-box`,
    { headers: { cookie: portalCookie } }
  );
  assert.equal(clientConfigResponse.status, 200);
  const clientConfig = await clientConfigResponse.json();
  assert.deepEqual(
    clientConfig.outbounds
      .filter((outbound) => outbound.type === "shadowsocks")
      .map((outbound) => outbound.server),
    ["local.example.com", "sg.example.com"]
  );
  assert.ok(clientConfig.outbounds.some((outbound) => outbound.type === "selector"));
  assert.ok(clientConfig.outbounds.some((outbound) => outbound.type === "urltest"));

  const rotateResponse = await api(
    testApp.baseUrl,
    adminCookie,
    `/api/users/${encodeURIComponent(user.id)}/subscription/rotate`,
    { method: "POST" }
  );
  assert.equal(rotateResponse.status, 201);
  const { formats } = await rotateResponse.json();
  const subscriptionPath = new URL(formats.singbox).pathname;
  const subscriptionResponse = await fetch(
    `${testApp.baseUrl}${subscriptionPath}?format=singbox`
  );
  assert.equal(subscriptionResponse.status, 200);
  assert.deepEqual(await subscriptionResponse.json(), clientConfig);
});

test("authenticated bootstrap reports current local host telemetry", async (t) => {
  let telemetrySamples = 0;
  const testApp = await startTestApp({
    telemetryIntervalMs: 20,
    telemetryProvider: async () => {
      telemetrySamples += 1;
      return {
        cpuPercent: 21.4,
        memoryUsedBytes: 3_000,
        memoryTotalBytes: 8_000,
        diskUsedBytes: 20_000,
        diskTotalBytes: 100_000,
        networkRxBytes: 40_000,
        networkTxBytes: 20_000,
        networkRxBps: 640_000,
        networkTxBps: 160_000,
        serviceStatus: "running"
      };
    }
  });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  await new Promise((resolve) => setTimeout(resolve, 45));

  const response = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const body = await response.json();
  const localHost = body.hosts.find((host) => host.id === "local");

  assert.equal(localHost.telemetry.cpuPercent, 21.4);
  assert.equal(localHost.telemetry.memoryUsedBytes, 3_000);
  assert.equal(localHost.telemetry.diskUsedBytes, 20_000);
  assert.equal(localHost.telemetry.diskTotalBytes, 100_000);
  assert.equal(localHost.telemetry.serviceStatus, "running");
  assert.equal(body.telemetry.networkSeries.at(-1).downloadBps, 640_000);
  assert.ok(telemetrySamples >= 2);
});

test("admin creates and updates a user-owned entitlement", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const userResponse = await api(testApp.baseUrl, cookie, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "徐清扬",
      email: "qingyang.xu@example.cn",
      quotaGb: 86,
      nodeScope: ["tokyo"],
      state: "disabled",
      expiresAt: "2027-01-31"
    })
  });
  assert.equal(userResponse.status, 201);
  const user = await userResponse.json();
  assert.equal(user.quotaGb, 86);
  assert.equal("deviceLimit" in user, false);
  assert.deepEqual(user.nodeScope, ["tokyo"]);
  assert.equal("clientFormats" in user, false);
  assert.equal(user.state, "disabled");
  assert.equal("planId" in user, false);
  assert.equal("runtimePassword" in user, false);
  assert.equal("runtimeUuid" in user, false);

  const updateResponse = await api(testApp.baseUrl, cookie, `/api/users/${user.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      quotaGb: 92,
      nodeScope: ["all"]
    })
  });
  assert.equal(updateResponse.status, 200);
  const updatedUser = await updateResponse.json();
  assert.equal(updatedUser.quotaGb, 92);
  assert.equal("deviceLimit" in updatedUser, false);
  assert.deepEqual(updatedUser.nodeScope, ["all"]);

  const bootstrap = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const snapshot = await bootstrap.json();
  assert.equal(snapshot.users.find((item) => item.id === user.id).quotaGb, 92);
  assert.equal("plans" in snapshot, false);

  const retiredPlanEndpoint = await api(testApp.baseUrl, cookie, "/api/plans", {
    method: "POST",
    body: JSON.stringify({})
  });
  assert.equal(retiredPlanEndpoint.status, 404);
});

test("user creation rejects invalid entitlement limits", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const response = await api(testApp.baseUrl, cookie, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "无效权益用户",
      email: "invalid-entitlement@example.cn",
      quotaGb: 0,
      nodeScope: ["tokyo"],
      clientFormats: ["sing-box"],
      expiresAt: "2027-01-31"
    })
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "INVALID_QUOTA");
});

test("admin previews and publishes the current database snapshot", async (t) => {
  const publications = [];
  const runtimeAdapter = {
    async publish(publication) {
      publications.push(publication);
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    },
    async status() {
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    }
  };
  const testApp = await startTestApp({ runtimeAdapter });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const previewResponse = await api(testApp.baseUrl, cookie, "/api/deployments/preview", { method: "POST" });
  assert.equal(previewResponse.status, 200);
  assert.equal((await previewResponse.json()).eligibleUsers, 5);

  const publishResponse = await api(testApp.baseUrl, cookie, "/api/deployments", { method: "POST" });
  assert.equal(publishResponse.status, 201);
  const deployment = await publishResponse.json();
  assert.equal(deployment.status, "active");
  assert.equal(publications.length, 1);

  const bootstrap = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const snapshot = await bootstrap.json();
  assert.equal(snapshot.runtime.state, "running");
  assert.equal(snapshot.deployments[0].status, "active");
  assert.equal(snapshot.deployments[0].publisherUsername, "admin");
});

test("disabling an entitled user automatically republishes runtime credentials", async (t) => {
  const publications = [];
  const runtimeAdapter = {
    async publish(publication) {
      publications.push(publication);
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    },
    async status() {
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    }
  };
  const testApp = await startTestApp({ runtimeAdapter });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const bootstrap = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const priya = (await bootstrap.json()).users.find((user) => user.email === "priya@vantage-bioworks.in");
  await api(testApp.baseUrl, cookie, "/api/deployments", { method: "POST" });
  assert.equal(publications.length, 1);

  const disableResponse = await api(testApp.baseUrl, cookie, `/api/users/${priya.id}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "disabled" })
  });
  assert.equal(disableResponse.status, 200);
  assert.equal(publications.length, 2);
  assert.doesNotMatch(publications[1].configText, /priya@vantage-bioworks\.in/);
});

test("a failed entitlement publication is reported as pending and remains retryable", async (t) => {
  const publications = [];
  let rejectPublication = false;
  const runtimeAdapter = {
    async publish(publication) {
      publications.push(publication);
      if (rejectPublication) throw new Error("runtime unavailable");
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    },
    async status() {
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    }
  };
  const testApp = await startTestApp({ runtimeAdapter });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const bootstrap = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const priya = (await bootstrap.json()).users.find((user) => user.email === "priya@vantage-bioworks.in");
  await api(testApp.baseUrl, cookie, "/api/deployments", { method: "POST" });

  rejectPublication = true;
  const disableResponse = await api(testApp.baseUrl, cookie, `/api/users/${priya.id}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "disabled" })
  });
  assert.equal(disableResponse.status, 202);
  const pendingUser = await disableResponse.json();
  assert.equal(pendingUser.state, "disabled");
  assert.equal(pendingUser.runtimeSync.status, "pending");

  rejectPublication = false;
  const retry = await testApp.app.runtimeManager.reconcile();
  assert.equal(retry.changed, true);
  assert.doesNotMatch(publications.at(-1).configText, /priya@vantage-bioworks\.in/);
});

test("BBR configuration remains pending until a capable Node executes and reports real kernel state", async (t) => {
  const f = await startTestApp({ seedDemoData: false }); t.after(() => f.close());
  const cookie = await login(f.baseUrl);
  const created = await (await api(f.baseUrl, cookie, "/api/hosts", { method: "POST", body: JSON.stringify({ name: "BBR Host", address: "bbr.example.com", region: "test" }) })).json();
  const enrolled = await fetch(`${f.baseUrl}/api/node/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: created.enrollmentToken, agentVersion: "0.9.0", platform: "linux", runtimeVersion: "1.14.2" }) });
  assert.equal(enrolled.status, 201);
  const credential = await enrolled.json();
  const nodeHeaders = { authorization: `Bearer ${credential.nodeSecret}`, "x-raylink-host-id": credential.hostId, "content-type": "application/json" };
  const path = `/api/hosts/${credential.hostId}/bbr`;
  assert.equal((await api(f.baseUrl, cookie, path, { method: "POST" })).status, 202);
  assert.equal((await api(f.baseUrl, cookie, path, { method: "POST" })).status, 409);
  let bootstrap = await (await api(f.baseUrl, cookie, "/api/bootstrap")).json();
  assert.equal(bootstrap.hosts.find(h => h.id === credential.hostId).bbrTask.pending, true);
  assert.equal(bootstrap.hosts.find(h => h.id === credential.hostId).telemetry.bbr, null);
  const task = await (await fetch(`${f.baseUrl}/api/node/tasks/next`, { headers: nodeHeaders })).json();
  assert.equal(task.kind, "configure-bbr");
  const completed = await fetch(`${f.baseUrl}/api/node/tasks/${task.id}/complete`, { method: "POST", headers: nodeHeaders, body: JSON.stringify({ attempt: task.attempt, status: "succeeded", result: {} }) });
  assert.equal(completed.status, 200);
  assert.equal((await fetch(`${f.baseUrl}/api/node/heartbeat`, { method: "POST", headers: nodeHeaders, body: JSON.stringify({ agentVersion: "0.9.0", telemetry: { bbr: { status: "enabled", congestionControl: "bbr", qdisc: "fq" } } }) })).status, 200);
  bootstrap = await (await api(f.baseUrl, cookie, "/api/bootstrap")).json();
  const host = bootstrap.hosts.find(h => h.id === credential.hostId);
  assert.equal(host.bbrTask.status, "succeeded");
  assert.equal(host.telemetry.bbr.status, "enabled");
  assert.ok(host.telemetry.bbr.checkedAt);
  assert.equal(bootstrap.runtimeSetup.status, "development");
  assert.equal(bootstrap.systemUpdate.supported, false);
  assert.equal((await api(f.baseUrl, cookie, "/api/hosts/local/bbr", { method: "POST" })).status, 422);
  assert.equal((await api(f.baseUrl, cookie, "/api/system/upgrade", { method: "POST" })).status, 422);
});

test("old Nodes and non-owner administrators cannot be queued for unsupported software updates", async (t) => {
  const f = await startTestApp({ seedDemoData: false }); t.after(() => f.close());
  const cookie = await login(f.baseUrl);
  const created = await (await api(f.baseUrl, cookie, "/api/hosts", { method: "POST", body: JSON.stringify({ name: "Legacy Node", address: "legacy.example.com", region: "test" }) })).json();
  const credential = await (await fetch(`${f.baseUrl}/api/node/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: created.enrollmentToken, agentVersion: "0.8.0", platform: "linux" }) })).json();
  for (const operation of ["bbr", "node-upgrade"]) {
    const response = await api(f.baseUrl, cookie, `/api/hosts/${credential.hostId}/${operation}`, { method: "POST" });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "NODE_UPGRADE_REQUIRED");
  }
  const operator = { username: "maintenance-operator", password: "test-maintenance-operator-password", role: "operator" };
  assert.equal((await api(f.baseUrl, cookie, "/api/admins", { method: "POST", body: JSON.stringify(operator) })).status, 201);
  const response = await fetch(`${f.baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(operator) });
  const operatorCookie = response.headers.getSetCookie()[0].split(";")[0];
  for (const path of ["/api/system/upgrade", `/api/hosts/${credential.hostId}/node-upgrade`]) {
    assert.equal((await api(f.baseUrl, operatorCookie, path, { method: "POST" })).status, 403);
  }
});

test("a durable system update blocks Runtime changes after the request that scheduled it has finished", async (t) => {
  const f = await startTestApp({
    seedDemoData: false,
    systemUpdateManager: { status: async () => ({ task: { status: "running" } }) }
  });
  t.after(() => f.close());
  const cookie = await login(f.baseUrl);
  for (const path of ["/api/runtime/install", "/api/deployments"]) {
    const response = await api(f.baseUrl, cookie, path, { method: "POST" });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "SYSTEM_UPDATE_BUSY");
  }
  assert.equal(f.app.store.listDeployments().length, 0);
});

test("admin can edit development profiles but cannot mistake a binary install for a running Linux service", async (t) => {
  let installCalls = 0;
  let installed = false;
  const installer = {
    async status() {
      return {
        installed: installed,
        version: installed ? "1.13.12" : null,
        platform: "darwin",
        architecture: "arm64",
        tags: installed ? ["with_quic", "with_utls"] : [],
        binaryPath: "sing-box"
      };
    },
    async install() {
      installCalls += 1;
      return this.status();
    },
    async generateRealityKeypair() {
      return { privateKey: "private-key", publicKey: "public-key" };
    }
  };
  const testApp = await startTestApp({ installer });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const initialResponse = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const initial = await initialResponse.json();
  assert.equal(initial.installation.installed, false);
  assert.equal(initial.hosts[0].protocols.find((profile) => profile.type === "shadowsocks").enabled, true);
  assert.ok(initial.protocolCatalog.some((protocol) => protocol.type === "hysteria2"));

  const installResponse = await api(testApp.baseUrl, cookie, "/api/runtime/install", { method: "POST" });
  assert.equal(installResponse.status, 422);
  assert.equal((await installResponse.json()).error.code, "RUNTIME_AUTOMATION_UNSUPPORTED");
  assert.equal(installCalls, 0);
  // A pre-existing binary can still be inspected/configured in the development fixture.
  installed = true;

  const updateResponse = await api(testApp.baseUrl, cookie, "/api/hosts/local/protocols/vless", {
    method: "PATCH",
    body: JSON.stringify({
      enabled: true,
      listen: "::",
      port: 8443,
      tls: { mode: "none" },
      transport: { type: "ws", path: "/raylink" },
      options: {}
    })
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).enabled, true);

  const previewResponse = await api(testApp.baseUrl, cookie, "/api/deployments/preview", { method: "POST" });
  const preview = await previewResponse.json();
  assert.equal(preview.inboundCount, 2);
  assert.deepEqual(preview.protocols, ["shadowsocks", "vless"]);

  const conflictResponse = await api(testApp.baseUrl, cookie, "/api/hosts/local/protocols/vmess", {
    method: "PATCH",
    body: JSON.stringify({
      enabled: true,
      listen: "::",
      port: 8443,
      tls: { mode: "none" },
      transport: { type: "none" },
      options: {}
    })
  });
  assert.equal(conflictResponse.status, 422);
  assert.equal((await conflictResponse.json()).error.code, "PROTOCOL_PORT_CONFLICT");
});

test("protocol profiles belong to one host and never enable the same protocol on another host", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const created = await (await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "新加坡入口",
      address: "sg.example.com",
      region: "singapore"
    })
  })).json();

  const pendingUpdate = await api(
    testApp.baseUrl,
    cookie,
    `/api/hosts/${encodeURIComponent(created.host.id)}/protocols/vless`,
    {
      method: "PATCH",
      body: JSON.stringify({
        enabled: true,
        listen: "::",
        port: 8443,
        tls: { mode: "none" },
        transport: { type: "none" },
        options: {}
      })
    }
  );
  assert.equal(pendingUpdate.status, 409);
  assert.equal((await pendingUpdate.json()).error.code, "HOST_CAPABILITIES_UNKNOWN");

  const enrollResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "sg-vps-01",
      platform: "linux",
      architecture: "amd64",
      agentVersion: "0.7.0",
      runtimeVersion: "1.13.12",
      buildTags: ["with_quic", "with_utls"]
    })
  });
  assert.equal(enrollResponse.status, 201);

  const updateResponse = await api(
    testApp.baseUrl,
    cookie,
    `/api/hosts/${encodeURIComponent(created.host.id)}/protocols/vless`,
    {
      method: "PATCH",
      body: JSON.stringify({
        enabled: true,
        listen: "::",
        port: 8443,
        tls: { mode: "none" },
        transport: { type: "none" },
        options: {}
      })
    }
  );
  assert.equal(updateResponse.status, 200);

  const bootstrap = await (await api(testApp.baseUrl, cookie, "/api/bootstrap")).json();
  const localVless = bootstrap.hosts
    .find((host) => host.id === "local")
    .protocols.find((profile) => profile.type === "vless");
  const remoteVless = bootstrap.hosts
    .find((host) => host.id === created.host.id)
    .protocols.find((profile) => profile.type === "vless");
  assert.equal(localVless.enabled, false);
  assert.equal(remoteVless.enabled, true);
});

test("client delivery keeps using the applied host protocols until the next deployment succeeds", async (t) => {
  const testApp = await startTestApp({ proxyHost: "node.example.com" });
  t.after(() => testApp.close());
  const adminCookie = await login(testApp.baseUrl);
  await api(testApp.baseUrl, adminCookie, "/api/deployments", { method: "POST" });
  const portalLogin = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = portalLogin.headers.getSetCookie()[0].split(";")[0];

  const update = await api(testApp.baseUrl, adminCookie, "/api/hosts/local/protocols/vless", {
    method: "PATCH",
    body: JSON.stringify({
      enabled: true,
      listen: "::",
      port: 8443,
      tls: { mode: "none" },
      transport: { type: "none" },
      options: {}
    })
  });
  assert.equal(update.status, 200);

  const beforePublish = await (await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  })).json();
  assert.deepEqual(
    beforePublish.outbounds.filter((outbound) => ["shadowsocks", "vless"].includes(outbound.type))
      .map((outbound) => outbound.type),
    ["shadowsocks"]
  );

  await api(testApp.baseUrl, adminCookie, "/api/deployments", { method: "POST" });
  const afterPublish = await (await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  })).json();
  assert.deepEqual(
    afterPublish.outbounds.filter((outbound) => ["shadowsocks", "vless"].includes(outbound.type))
      .map((outbound) => outbound.type),
    ["shadowsocks", "vless"]
  );
});

test("admin surface keeps protocols on hosts and exposes universal client delivery", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const response = await fetch(`${testApp.baseUrl}/`);
  const html = await response.text();
  const script = await (await fetch(`${testApp.baseUrl}/app.js`)).text();

  assert.doesNotMatch(html, /data-view="services"/);
  assert.doesNotMatch(html, /data-view-target="services"/);
  assert.match(script, /Clash \/ Mihomo/);
  assert.match(script, /Egern/);
  assert.match(script, /sing-box/);
  assert.match(html, /入口协议/);
});

test("admin checks, upgrades the local Runtime and queues a remote Runtime upgrade", async (t) => {
  let localVersion = "1.13.12";
  let upgradeCalls = 0;
  const release = () => ({
    status: "ready",
    currentVersion: localVersion,
    latestVersion: "1.14.2",
    approvedVersion: "1.14.2",
    updateAvailable: localVersion !== "1.14.2",
    compatible: true,
    checkedAt: "2026-07-26T08:00:00.000Z",
    releaseUrl: "https://github.com/SagerNet/sing-box/releases/tag/v1.14.2"
  });
  const installer = {
    async status() {
      return {
        installed: true,
        version: localVersion,
        platform: "linux",
        architecture: "amd64",
        tags: ["with_quic"],
        binaryPath: "/usr/local/bin/sing-box"
      };
    },
    releaseStatus: release,
    async checkForUpdates() {
      return release();
    },
    async upgrade(targetVersion) {
      upgradeCalls += 1;
      localVersion = targetVersion;
      return { ...await this.status(), previousVersion: "1.13.12", rolledBack: false };
    }
  };
  const testApp = await startTestApp({ installer });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const checkResponse = await api(testApp.baseUrl, cookie, "/api/runtime/update");
  assert.equal(checkResponse.status, 200);
  assert.equal((await checkResponse.json()).latestVersion, "1.14.2");

  const upgradeResponse = await api(testApp.baseUrl, cookie, "/api/runtime/upgrade", {
    method: "POST"
  });
  assert.equal(upgradeResponse.status, 200);
  assert.equal((await upgradeResponse.json()).version, "1.14.2");
  assert.equal(upgradeCalls, 1);

  const created = await (await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "新加坡升级节点",
      address: "upgrade-sg.example.com",
      region: "singapore"
    })
  })).json();
  const enrolled = await (await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "upgrade-sg",
      agentVersion: "0.7.0",
      runtimeVersion: "1.14.2",
      buildTags: ["with_quic"]
    })
  })).json();

  const oldNodeUpgrade = await api(testApp.baseUrl, cookie,
    `/api/hosts/${encodeURIComponent(enrolled.hostId)}/runtime-upgrade`, { method: "POST" });
  assert.equal(oldNodeUpgrade.status, 409);
  assert.equal((await oldNodeUpgrade.json()).error.code, "NODE_UPGRADE_REQUIRED");
  const nodeHeaders = { authorization: `Bearer ${enrolled.nodeSecret}`,
    "x-raylink-host-id": enrolled.hostId, "content-type": "application/json" };
  assert.equal((await fetch(`${testApp.baseUrl}/api/node/tasks/next`, { headers: nodeHeaders })).status, 204);
  const nodeUpdate = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST", headers: nodeHeaders,
    body: JSON.stringify({ agentVersion: "0.8.0", runtimeVersion: "1.14.2", buildTags: ["with_quic"] })
  });
  assert.equal(nodeUpdate.status, 200);

  const remoteUpgrade = await api(
    testApp.baseUrl,
    cookie,
    `/api/hosts/${encodeURIComponent(enrolled.hostId)}/runtime-upgrade`,
    { method: "POST" }
  );
  assert.equal(remoteUpgrade.status, 202);
  const queued = await remoteUpgrade.json();
  assert.equal(queued.targetVersion, "1.14.2");

  const task = await (await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: {
      authorization: `Bearer ${enrolled.nodeSecret}`,
      "x-raylink-host-id": enrolled.hostId
    }
  })).json();
  assert.equal(task.kind, "upgrade-runtime");
  assert.equal(task.payload.targetVersion, "1.14.2");
  await fetch(`${testApp.baseUrl}/api/node/tasks/${encodeURIComponent(task.id)}/complete`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${enrolled.nodeSecret}`,
      "content-type": "application/json",
      "x-raylink-host-id": enrolled.hostId
    },
    body: JSON.stringify({
      attempt: task.attempt,
      status: "failed",
      result: {
        error: "candidate failed health window",
        previousVersion: "1.13.12",
        rolledBack: true,
        packageMetadataRestored: true
      }
    })
  });
  const afterFailure = await (await api(testApp.baseUrl, cookie, "/api/bootstrap")).json();
  const failedHost = afterFailure.hosts.find((host) => host.id === enrolled.hostId);
  assert.equal(failedHost.runtimeUpgrade.status, "failed");
  assert.equal(failedHost.runtimeUpgrade.rolledBack, true);
  assert.equal(failedHost.runtimeUpgrade.previousVersion, "1.13.12");
  assert.equal(failedHost.runtimeUpgrade.packageMetadataRestored, true);
  assert.equal(failedHost.runtimeUpgrade.error, "candidate failed health window");
});

test("admin cannot enable Reality or QUIC transport when the sing-box build tags are missing", async (t) => {
  const installer = {
    async status() {
      return {
        installed: true,
        version: "1.13.12",
        platform: "linux",
        architecture: "amd64",
        tags: [],
        binaryPath: "sing-box"
      };
    }
  };
  const testApp = await startTestApp({ installer });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const baseProfile = {
    enabled: true,
    listen: "::",
    port: 8443,
    options: {}
  };

  const realityResponse = await api(testApp.baseUrl, cookie, "/api/hosts/local/protocols/vless", {
    method: "PATCH",
    body: JSON.stringify({
      ...baseProfile,
      tls: {
        mode: "reality",
        serverName: "www.microsoft.com",
        handshakeServer: "www.microsoft.com",
        handshakePort: 443,
        privateKey: "private-key",
        publicKey: "public-key",
        shortId: "0123456789abcdef"
      },
      transport: { type: "none" }
    })
  });
  assert.equal(realityResponse.status, 422);
  assert.equal((await realityResponse.json()).error.code, "REALITY_UNAVAILABLE");

  const quicResponse = await api(testApp.baseUrl, cookie, "/api/hosts/local/protocols/vless", {
    method: "PATCH",
    body: JSON.stringify({
      ...baseProfile,
      tls: {
        mode: "certificate",
        serverName: "node.example.com",
        certificatePath: "/tmp/cert.pem",
        keyPath: "/tmp/key.pem"
      },
      transport: { type: "quic" }
    })
  });
  assert.equal(quicResponse.status, 422);
  assert.equal((await quicResponse.json()).error.code, "QUIC_UNAVAILABLE");
});

test("active user logs in and downloads a credential-scoped sing-box client config", async (t) => {
  const testApp = await startTestApp({ proxyHost: "node.cyclelink.org", listenPort: 8388 });
  t.after(() => testApp.close());

  const loginResponse = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  assert.equal(loginResponse.status, 200);
  const portalCookie = loginResponse.headers.getSetCookie()[0].split(";")[0];

  const profileResponse = await fetch(`${testApp.baseUrl}/api/portal/me`, {
    headers: { cookie: portalCookie }
  });
  assert.equal(profileResponse.status, 200);
  const profile = await profileResponse.json();
  assert.equal("planId" in profile.user, false);
  assert.equal("deviceLimit" in profile.entitlement, false);
  assert.equal(profile.entitlement.quotaGb, 320);

  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });
  assert.equal(configResponse.status, 200);
  assert.equal(
    configResponse.headers.get("subscription-userinfo"),
    [
      "upload=0",
      `download=${Math.round(75.4 * (1024 ** 3))}`,
      `total=${320 * (1024 ** 3)}`,
      `expire=${Math.floor(new Date("2030-09-01T23:59:59.999Z").getTime() / 1000)}`
    ].join("; ")
  );
  const config = await configResponse.json();
  assert.equal(config.outbounds[0].server, "node.cyclelink.org");
  assert.equal(config.outbounds[0].server_port, 8388);
  assert.ok(config.outbounds[0].password);
  const passwordParts = config.outbounds[0].password.split(":");
  assert.equal(passwordParts.length, 2);
  assert.equal(Buffer.from(passwordParts[0], "base64").length, 16);
  assert.equal(Buffer.from(passwordParts[1], "base64").length, 16);
  assert.equal(JSON.stringify(config).includes("shadowsocks_master_password"), false);
});

test("portal excludes a staged local Runtime when production delivery is enforced", async (t) => {
  const testApp = await startTestApp({
    proxyHost: "node.example.com",
    allowStagedClientConfigs: false
  });
  t.after(() => testApp.close());
  const loginResponse = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = loginResponse.headers.getSetCookie()[0].split(";")[0];

  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });

  assert.equal(configResponse.status, 403);
  assert.equal((await configResponse.json()).error.code, "ENTITLEMENT_INACTIVE");
});

test("user creates a stable subscription URL and rotating it revokes the old URL", async (t) => {
  const testApp = await startTestApp({
    proxyHost: "node.example.com",
    subscriptionOrigin: "https://sub.example.com",
    trustProxy: true
  });
  t.after(() => testApp.close());
  const loginResponse = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = loginResponse.headers.getSetCookie()[0].split(";")[0];

  const forgedRotate = await fetch(
    `${testApp.baseUrl}/api/portal/subscription/rotate`,
    {
      method: "POST",
      headers: {
        cookie: portalCookie,
        origin: "https://untrusted.example"
      }
    }
  );
  assert.equal(forgedRotate.status, 403);
  assert.equal((await forgedRotate.json()).error.code, "ORIGIN_REJECTED");

  const firstRotate = await fetch(`${testApp.baseUrl}/api/portal/subscription/rotate`, {
    method: "POST",
    headers: { cookie: portalCookie }
  });
  assert.equal(firstRotate.status, 201);
  const first = await firstRotate.json();
  assert.equal(new URL(first.subscriptionUrl).origin, "https://sub.example.com");
  const firstSubscriptionPath = new URL(first.subscriptionUrl).pathname;
  assert.match(firstSubscriptionPath, /^\/sub\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/);
  const currentSubscription = await fetch(
    `${testApp.baseUrl}/api/portal/subscription`,
    { headers: { cookie: portalCookie } }
  );
  assert.equal(currentSubscription.status, 200);
  assert.equal(
    (await currentSubscription.json()).subscriptionUrl,
    first.subscriptionUrl
  );

  const isolatedControlPlane = await fetch(`${testApp.baseUrl}/api/bootstrap`, {
    headers: { "x-forwarded-host": "sub.example.com" }
  });
  assert.equal(isolatedControlPlane.status, 404);

  const firstSingBoxPath = `${firstSubscriptionPath}?format=singbox`;
  const subscriptionResponse = await fetch(`${testApp.baseUrl}${firstSingBoxPath}`, {
    headers: { "x-forwarded-host": "sub.example.com" }
  });
  assert.equal(subscriptionResponse.status, 200);
  assert.match(subscriptionResponse.headers.get("content-disposition"), /raylink-sing-box\.json/);
  assert.equal(subscriptionResponse.headers.get("cache-control"), "private, no-cache");
  assert.doesNotMatch(subscriptionResponse.headers.get("cache-control"), /public/);
  const subscriptionEtag = subscriptionResponse.headers.get("etag");
  assert.match(subscriptionEtag, /^"[a-f0-9]{64}"$/);
  const subscriptionConfig = await subscriptionResponse.json();
  assert.equal(subscriptionConfig.inbounds[0].type, "tun");
  assert.equal(subscriptionConfig.route.final, "raylink-auto");
  const notModifiedResponse = await fetch(`${testApp.baseUrl}${firstSingBoxPath}`, {
    headers: { "if-none-match": subscriptionEtag }
  });
  assert.equal(notModifiedResponse.status, 304);

  const second = await (await fetch(`${testApp.baseUrl}/api/portal/subscription/rotate`, {
    method: "POST",
    headers: { cookie: portalCookie }
  })).json();
  assert.notEqual(second.subscriptionUrl, first.subscriptionUrl);
  const secondSubscriptionPath = new URL(second.subscriptionUrl).pathname;

  const revokedResponse = await fetch(`${testApp.baseUrl}${firstSubscriptionPath}`);
  assert.equal(revokedResponse.status, 401);
  assert.equal((await revokedResponse.json()).error.code, "SUBSCRIPTION_INVALID");
  assert.equal((await fetch(`${testApp.baseUrl}${secondSubscriptionPath}`)).status, 200);
});

test("one universal subscription URL negotiates Mihomo, Loon, Egern and sing-box formats", async (t) => {
  const testApp = await startTestApp({
    proxyHost: "node.example.com",
    subscriptionOrigin: "https://sub.example.com"
  });
  t.after(() => testApp.close());
  const loginResponse = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = loginResponse.headers.getSetCookie()[0].split(";")[0];
  const created = await (await fetch(`${testApp.baseUrl}/api/portal/subscription/rotate`, {
    method: "POST",
    headers: { cookie: portalCookie }
  })).json();
  const subscription = new URL(created.subscriptionUrl);

  assert.match(subscription.pathname, /^\/sub\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/);
  assert.equal(created.formats.mihomo, `${created.subscriptionUrl}?format=mihomo`);
  assert.equal(created.formats.loon, created.subscriptionUrl);
  assert.equal(created.formats.egern, `${created.subscriptionUrl}?format=egern`);
  assert.equal(created.formats.singbox, `${created.subscriptionUrl}?format=singbox`);

  const mihomo = await fetch(`${testApp.baseUrl}${subscription.pathname}`, {
    headers: { "user-agent": "clash-verge/v2.5.2" }
  });
  assert.equal(mihomo.status, 200);
  assert.match(mihomo.headers.get("content-type"), /application\/yaml/);
  assert.match(mihomo.headers.get("content-disposition"), /raylink-mihomo\.yaml/);
  assert.equal(
    mihomo.headers.get("subscription-userinfo"),
    [
      "upload=0",
      `download=${Math.round(75.4 * (1024 ** 3))}`,
      `total=${320 * (1024 ** 3)}`,
      `expire=${Math.floor(new Date("2030-09-01T23:59:59.999Z").getTime() / 1000)}`
    ].join("; ")
  );
  assert.match(await mihomo.text(), /^mixed-port: 7890/m);

  const loon = await fetch(`${testApp.baseUrl}${subscription.pathname}?format=loon`);
  assert.equal(loon.status, 200);
  assert.match(loon.headers.get("content-type"), /text\/plain/);
  assert.match(loon.headers.get("content-disposition"), /raylink-loon\.list/);
  assert.match(await loon.text(), /^[^\n=]+=(?:shadowsocks|vmess|vless|trojan|anytls|Hysteria2),/m);

  const loonDetected = await fetch(`${testApp.baseUrl}${subscription.pathname}`, {
    headers: { "user-agent": "Loon/933" }
  });
  assert.equal(loonDetected.status, 200);
  assert.match(loonDetected.headers.get("content-disposition"), /raylink-loon\.list/);

  const loonPath = await fetch(`${testApp.baseUrl}${subscription.pathname}/loon.list`);
  assert.equal(loonPath.status, 200);
  assert.match(loonPath.headers.get("content-disposition"), /raylink-loon\.list/);

  const mihomoHead = await fetch(`${testApp.baseUrl}${subscription.pathname}`, {
    method: "HEAD",
    headers: { "user-agent": "clash-verge/v2.5.2" }
  });
  assert.equal(mihomoHead.status, 200);
  assert.match(mihomoHead.headers.get("content-type"), /application\/yaml/);
  assert.ok(Number(mihomoHead.headers.get("content-length")) > 0);
  assert.equal(
    mihomoHead.headers.get("subscription-userinfo"),
    mihomo.headers.get("subscription-userinfo")
  );
  assert.equal(await mihomoHead.text(), "");

  const user = testApp.app.store.listUsers()
    .find((candidate) => candidate.email === "priya@vantage-bioworks.in");
  testApp.app.store.updateUser(user.id, { usedGb: 76 });
  const refreshedMihomo = await fetch(`${testApp.baseUrl}${subscription.pathname}`, {
    headers: {
      "if-none-match": mihomo.headers.get("etag"),
      "user-agent": "clash-verge/v2.5.2"
    }
  });
  assert.equal(refreshedMihomo.status, 200);
  assert.match(
    refreshedMihomo.headers.get("subscription-userinfo"),
    new RegExp(`download=${76 * (1024 ** 3)}(?:;|$)`)
  );

  const egern = await fetch(`${testApp.baseUrl}${subscription.pathname}?format=egern`);
  assert.equal(egern.status, 200);
  assert.match(egern.headers.get("content-disposition"), /raylink-egern\.yaml/);
  assert.match(await egern.text(), /^proxies:/m);

  const egernDetected = await fetch(`${testApp.baseUrl}${subscription.pathname}`, {
    headers: { "user-agent": "Egern/1.26 Clash-compatible" }
  });
  assert.equal(egernDetected.status, 200);
  assert.match(egernDetected.headers.get("content-disposition"), /raylink-egern\.yaml/);

  const profile = await fetch(`${testApp.baseUrl}${subscription.pathname}?format=egern-profile`);
  assert.equal(profile.status, 200);
  assert.match(profile.headers.get("content-disposition"), /raylink-egern-profile\.yaml/);
  assert.match(await profile.text(), /^policy_groups:/m);

  const singBox = await fetch(`${testApp.baseUrl}${subscription.pathname}?format=singbox`);
  assert.equal(singBox.status, 200);
  assert.match(singBox.headers.get("content-type"), /application\/json/);
  assert.equal((await singBox.json()).route.final, "raylink-auto");

  const legacySingBox = await fetch(
    `${testApp.baseUrl}${subscription.pathname}/sing-box.json`
  );
  assert.equal(legacySingBox.status, 200);
  assert.equal((await legacySingBox.json()).route.final, "raylink-auto");

  const unsupported = await fetch(
    `${testApp.baseUrl}${subscription.pathname}?format=unknown`
  );
  assert.equal(unsupported.status, 400);
  assert.equal(
    (await unsupported.json()).error.code,
    "SUBSCRIPTION_FORMAT_UNSUPPORTED"
  );

  const landing = await fetch(`${testApp.baseUrl}${subscription.pathname}`, {
    headers: {
      accept: "text/html",
      "user-agent": "Mozilla/5.0"
    }
  });
  assert.equal(landing.status, 200);
  assert.match(landing.headers.get("content-type"), /text\/html/);
  const landingHtml = await landing.text();
  assert.match(landingHtml, /Clash Verge Rev/);
  assert.match(landingHtml, /Loon/);
  assert.ok(landingHtml.includes(`<code>${created.subscriptionUrl}</code>`));
  assert.ok(!landingHtml.includes(`href="${created.subscriptionUrl}"`));
  assert.match(landingHtml, /Egern 智能配置/);
  assert.match(landingHtml, /Egern 节点订阅/);
  assert.match(landingHtml, /sing-box/);
  assert.doesNotMatch(landingHtml, /raylink-demo/);
});

test("administrator can generate a user's subscription URL and rotating it revokes the old URL", async (t) => {
  const testApp = await startTestApp({
    proxyHost: "node.example.com",
    subscriptionOrigin: "https://sub.example.com"
  });
  t.after(() => testApp.close());
  const adminCookie = await login(testApp.baseUrl);
  const bootstrap = await (
    await api(testApp.baseUrl, adminCookie, "/api/bootstrap")
  ).json();
  const user = bootstrap.users.find(
    (candidate) => candidate.email === "priya@vantage-bioworks.in"
  );
  assert.ok(user);

  const unauthenticated = await fetch(
    `${testApp.baseUrl}/api/users/${encodeURIComponent(user.id)}/subscription/rotate`,
    { method: "POST" }
  );
  assert.equal(unauthenticated.status, 401);

  const firstResponse = await api(
    testApp.baseUrl,
    adminCookie,
    `/api/users/${encodeURIComponent(user.id)}/subscription/rotate`,
    { method: "POST" }
  );
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  assert.equal(new URL(first.subscriptionUrl).origin, "https://sub.example.com");
  const firstPath = new URL(first.subscriptionUrl).pathname;
  assert.equal((await fetch(`${testApp.baseUrl}${firstPath}`)).status, 200);
  const currentResponse = await api(
    testApp.baseUrl,
    adminCookie,
    `/api/users/${encodeURIComponent(user.id)}/subscription`
  );
  assert.equal(currentResponse.status, 200);
  assert.equal(
    (await currentResponse.json()).subscriptionUrl,
    first.subscriptionUrl
  );
  testApp.app.store.db.prepare(`
    UPDATE users
    SET subscription_secret_encrypted = NULL
    WHERE id = ?
  `).run(user.id);
  const legacyResponse = await api(
    testApp.baseUrl,
    adminCookie,
    `/api/users/${encodeURIComponent(user.id)}/subscription`
  );
  assert.equal(legacyResponse.status, 409);
  assert.equal(
    (await legacyResponse.json()).error.code,
    "SUBSCRIPTION_ADDRESS_UNAVAILABLE"
  );

  const secondResponse = await api(
    testApp.baseUrl,
    adminCookie,
    `/api/users/${encodeURIComponent(user.id)}/subscription/rotate`,
    { method: "POST" }
  );
  assert.equal(secondResponse.status, 201);
  const second = await secondResponse.json();
  assert.notEqual(second.subscriptionUrl, first.subscriptionUrl);
  const secondPath = new URL(second.subscriptionUrl).pathname;

  assert.equal((await fetch(`${testApp.baseUrl}${firstPath}`)).status, 401);
  assert.equal((await fetch(`${testApp.baseUrl}${secondPath}`)).status, 200);
});

test("subscription uses control-plane managed official rule sets when cached", async (t) => {
  const ruleSetFiles = new Map([
    ["geosite-geolocation-cn.srs", Buffer.from("managed-geosite")],
    ["geoip-cn.srs", Buffer.from("managed-geoip")]
  ]);
  const testApp = await startTestApp({
    proxyHost: "node.example.com",
    subscriptionOrigin: "https://sub.example.com",
    ruleSetCache: {
      prepare: async () => {},
      available: () => true,
      get: async (filename) => ruleSetFiles.get(filename) || null
    }
  });
  t.after(() => testApp.close());
  const loginResponse = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = loginResponse.headers.getSetCookie()[0].split(";")[0];
  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });
  const config = await configResponse.json();
  assert.ok(config.route.rule_set.every((ruleSet) => ruleSet.type === "remote"));
  assert.deepEqual(
    config.route.rule_set.map((ruleSet) => new URL(ruleSet.url).pathname),
    ["/rule-sets/geosite-geolocation-cn.srs", "/rule-sets/geoip-cn.srs"]
  );
  assert.ok(
    config.route.rule_set.every(
      (ruleSet) => new URL(ruleSet.url).origin === "https://sub.example.com"
    )
  );

  const ruleSetResponse = await fetch(`${testApp.baseUrl}/rule-sets/geosite-geolocation-cn.srs`);
  assert.equal(ruleSetResponse.status, 200);
  assert.equal(ruleSetResponse.headers.get("content-type"), "application/octet-stream");
  assert.equal(await ruleSetResponse.text(), "managed-geosite");
});

test("offline cold start serves the complete bundled routing baseline and reports its version", async (t) => {
  const testApp = await startTestApp({
    proxyHost: "node.example.com",
    ruleSetCache: undefined,
    ruleSetFetch: async () => new Response("not-a-binary-rule-set", { status: 200 })
  });
  t.after(() => testApp.close());
  const adminCookie = await login(testApp.baseUrl);
  const bootstrap = await (await api(testApp.baseUrl, adminCookie, "/api/bootstrap")).json();
  assert.equal(bootstrap.routingRuleSets.available, true);
  assert.equal(bootstrap.routingRuleSets.degraded, false);
  assert.ok(bootstrap.routingRuleSets.version);
  const loginResponse = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = loginResponse.headers.getSetCookie()[0].split(";")[0];
  const config = await (await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  })).json();
  assert.ok(config.route.rule_set.every((ruleSet) => ruleSet.type === "remote"));
  assert.equal(
    (await fetch(`${testApp.baseUrl}/rule-sets/geosite-geolocation-cn.srs`)).status,
    200
  );
});

test("invited user cannot log in before activation", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const response = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "lars@nordhavn-data.se",
      password: "raylink-demo"
    })
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "ACCOUNT_NOT_ACTIVE");
});

test("admin can activate a new portal user with a separate login password", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const createResponse = await api(testApp.baseUrl, cookie, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "赵明",
      email: "zhao.ming@example.cn",
      password: "PortalPass@2026",
      portalStatus: "active",
      state: "active",
      quotaGb: 120,
      nodeScope: ["tokyo", "singapore"],
      clientFormats: ["sing-box"],
      expiresAt: "2027-01-31"
    })
  });
  assert.equal(createResponse.status, 201);
  assert.equal((await createResponse.json()).portalStatus, "active");

  const portalResponse = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "zhao.ming@example.cn", password: "PortalPass@2026" })
  });
  assert.equal(portalResponse.status, 200);
  assert.equal((await portalResponse.json()).user.email, "zhao.ming@example.cn");
});

test("admin resets an existing user password without changing the entitlement or subscription", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const adminCookie = await login(testApp.baseUrl);
  const beforeBootstrap = await (await api(
    testApp.baseUrl,
    adminCookie,
    "/api/bootstrap"
  )).json();
  const before = beforeBootstrap.users.find(
    (candidate) => candidate.email === "priya@vantage-bioworks.in"
  );

  const existingLogin = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: before.email,
      password: "raylink-demo"
    })
  });
  assert.equal(existingLogin.status, 200);
  const existingCookie = existingLogin.headers.getSetCookie()[0].split(";")[0];

  const resetResponse = await api(
    testApp.baseUrl,
    adminCookie,
    `/api/users/${encodeURIComponent(before.id)}/password/reset`,
    {
      method: "POST",
      body: JSON.stringify({ password: "NewPortal@2026" })
    }
  );
  assert.equal(resetResponse.status, 200);
  assert.deepEqual(await resetResponse.json(), {
    passwordReset: true,
    sessionsRevoked: 1
  });

  const staleSession = await fetch(`${testApp.baseUrl}/api/portal/me`, {
    headers: { cookie: existingCookie }
  });
  assert.equal(staleSession.status, 401);

  const oldPassword = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: before.email, password: "raylink-demo" })
  });
  assert.equal(oldPassword.status, 401);

  const newPassword = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: before.email, password: "NewPortal@2026" })
  });
  assert.equal(newPassword.status, 200);

  const afterBootstrap = await (await api(
    testApp.baseUrl,
    adminCookie,
    "/api/bootstrap"
  )).json();
  const after = afterBootstrap.users.find((candidate) => candidate.id === before.id);
  assert.deepEqual(
    {
      usedGb: after.usedGb,
      quotaGb: after.quotaGb,
      nodeScope: after.nodeScope,
      expiresAt: after.expiresAt,
      subscription: after.subscription
    },
    {
      usedGb: before.usedGb,
      quotaGb: before.quotaGb,
      nodeScope: before.nodeScope,
      expiresAt: before.expiresAt,
      subscription: before.subscription
    }
  );
});

test("FlClash subscription keeps the Host domain while pinning its resolved dial address", async (t) => {
  let resolvedAddress = "203.0.113.20";
  const testApp = await startTestApp({
    proxyHost: "node.example.com",
    localHostDialAddress: "203.0.113.10",
    endpointResolver: {
      resolve: async () => ({
        address: resolvedAddress,
        source: "dns"
      })
    }
  });
  t.after(() => testApp.close());

  const loginResponse = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  assert.equal(loginResponse.status, 200);
  const portalCookie = loginResponse.headers.getSetCookie()[0].split(";")[0];
  const created = await (await fetch(`${testApp.baseUrl}/api/portal/subscription/rotate`, {
    method: "POST",
    headers: { cookie: portalCookie }
  })).json();
  const subscriptionPath = new URL(created.subscriptionUrl).pathname;

  const response = await fetch(`${testApp.baseUrl}${subscriptionPath}`, {
    headers: { "user-agent": "FlClash/v0.8.91 mihomo" }
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/yaml/);
  const body = await response.text();

  assert.match(body, /server: "node\.example\.com"/);
  assert.match(body, /hosts:\n  "node\.example\.com": "203\.0\.113\.20"/);
  assert.match(body, /fake-ip-filter:\n    - "node\.example\.com"/);
  assert.match(body, /proxy-server-nameserver-policy:\n    "node\.example\.com":/);
  assert.doesNotMatch(body, /server: "203\.0\.113\.20"/);

  resolvedAddress = "203.0.113.21";
  const refreshed = await fetch(`${testApp.baseUrl}${subscriptionPath}`, {
    headers: {
      "if-none-match": response.headers.get("etag"),
      "user-agent": "FlClash/v0.8.91 mihomo"
    }
  });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.headers.get("etag"), response.headers.get("etag"));
  assert.match(
    await refreshed.text(),
    /hosts:\n  "node\.example\.com": "203\.0\.113\.21"/
  );
});

test("admin updates the single runtime host used by portal client configs", async (t) => {
  const testApp = await startTestApp({ proxyHost: "old-node.example.com", listenPort: 8388 });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const updateResponse = await api(testApp.baseUrl, cookie, "/api/hosts/local", {
    method: "PATCH",
    body: JSON.stringify({
      name: "东京生产节点",
      address: "node.example.com",
      region: "tokyo"
    })
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).address, "node.example.com");

  const portalLogin = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = portalLogin.headers.getSetCookie()[0].split(";")[0];
  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });
  assert.equal((await configResponse.json()).outbounds[0].server, "node.example.com");
});

test("configured endpoint fallback avoids Fake-IP without replacing the Host address", async (t) => {
  const testApp = await startTestApp({
    proxyHost: "node.example.com",
    localHostDialAddress: "203.0.113.10"
  });
  t.after(() => testApp.close());
  const adminCookie = await login(testApp.baseUrl);
  const bootstrap = await (await api(
    testApp.baseUrl,
    adminCookie,
    "/api/bootstrap"
  )).json();
  assert.equal(bootstrap.hosts.find((host) => host.id === "local").address, "node.example.com");

  const portalLogin = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  assert.equal(portalLogin.status, 200);
  const portalCookie = portalLogin.headers.getSetCookie()[0].split(";")[0];
  const config = await (await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  })).json();
  const shadowsocks = config.outbounds.find((outbound) => outbound.type === "shadowsocks");

  assert.equal(shadowsocks.server, "node.example.com");
  assert.equal(shadowsocks.domain_resolver, "raylink-endpoint-hosts");
  assert.deepEqual(
    config.dns.servers.find((server) => server.tag === "raylink-endpoint-hosts")?.predefined,
    { "node.example.com": "203.0.113.10" }
  );

  const loonResponse = await fetch(`${testApp.baseUrl}/api/portal/config/loon`, {
    headers: { cookie: portalCookie }
  });
  assert.equal(loonResponse.status, 200);
  assert.match(await loonResponse.text(), /=shadowsocks,203\.0\.113\.10,8388,/);
});

test("admin creates a remote host and RayLink Node enrolls with a one-time token", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const createResponse = await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "新加坡二号机",
      address: "sg-2.example.com",
      region: "singapore"
    })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.host.kind, "remote");
  assert.equal(created.host.status, "pending");
  assert.match(created.enrollmentToken, /^[A-Za-z0-9_-]{40,}$/);

  const bootstrapResponse = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const bootstrap = await bootstrapResponse.json();
  const pendingHost = bootstrap.hosts.find((host) => host.id === created.host.id);
  assert.equal(pendingHost.status, "pending");
  assert.equal("enrollmentToken" in pendingHost, false);

  const enrollResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "sg-vps-02",
      platform: "linux",
      architecture: "amd64",
      agentVersion: "0.1.0",
      runtimeVersion: "1.13.12",
      buildTags: ["with_quic", "with_utls"]
    })
  });
  assert.equal(enrollResponse.status, 201);
  const enrolled = await enrollResponse.json();
  assert.equal(enrolled.hostId, created.host.id);
  assert.match(enrolled.nodeSecret, /^[A-Za-z0-9_-]{40,}$/);

  const reuseResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: created.enrollmentToken })
  });
  assert.equal(reuseResponse.status, 401);

  const heartbeatResponse = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${enrolled.nodeSecret}`,
      "content-type": "application/json",
      "x-raylink-host-id": enrolled.hostId
    },
    body: JSON.stringify({
      runtimeState: "running",
      runtimeVersion: "1.13.12",
      agentVersion: "0.1.0",
      telemetry: {
        cpuPercent: 37.5,
        memoryUsedBytes: 2_147_483_648,
        memoryTotalBytes: 4_294_967_296,
        diskUsedBytes: 8_589_934_592,
        diskTotalBytes: 21_474_836_480,
        networkRxBytes: 12_884_901_888,
        networkTxBytes: 3_221_225_472,
        networkRxBps: 12_500_000,
        networkTxBps: 2_500_000,
        serviceStatus: "running"
      }
    })
  });
  assert.equal(heartbeatResponse.status, 200);
  assert.equal((await heartbeatResponse.json()).nextPollSeconds, 10);

  const refreshedResponse = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const refreshed = await refreshedResponse.json();
  const onlineHost = refreshed.hosts.find((host) => host.id === created.host.id);
  assert.equal(onlineHost.status, "online");
  assert.equal(onlineHost.runtimeVersion, "1.13.12");
  assert.ok(onlineHost.lastSeenAt);
  assert.deepEqual({
    ...onlineHost.telemetry,
    updatedAt: undefined
  }, {
    cpuPercent: 37.5,
    memoryUsedBytes: 2_147_483_648,
    memoryTotalBytes: 4_294_967_296,
    diskUsedBytes: 8_589_934_592,
    diskTotalBytes: 21_474_836_480,
    networkRxBytes: 12_884_901_888,
    networkTxBytes: 3_221_225_472,
    networkRxBps: 12_500_000,
    networkTxBps: 2_500_000,
    serviceStatus: "running",
    bbr: null,
    updatedAt: undefined
  });
  assert.ok(onlineHost.telemetry.updatedAt);
  assert.equal(refreshed.telemetry.networkSeries.at(-1).downloadBps, 12_500_000);
  assert.equal(refreshed.telemetry.networkSeries.at(-1).uploadBps, 2_500_000);

  const failedHeartbeat = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${enrolled.nodeSecret}`,
      "content-type": "application/json",
      "x-raylink-host-id": enrolled.hostId
    },
    body: JSON.stringify({ telemetry: { serviceStatus: "failed" } })
  });
  assert.equal(failedHeartbeat.status, 200);
  let recoveryBootstrap = await (await api(testApp.baseUrl, cookie, "/api/bootstrap")).json();
  assert.equal(recoveryBootstrap.hosts.find((host) => host.id === created.host.id).status, "degraded");

  const recoveredHeartbeat = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${enrolled.nodeSecret}`,
      "content-type": "application/json",
      "x-raylink-host-id": enrolled.hostId
    },
    body: JSON.stringify({
      telemetry: {
        networkRxBytes: null,
        networkTxBytes: null,
        networkRxBps: 1_000,
        networkTxBps: 2_000,
        serviceStatus: "running"
      }
    })
  });
  assert.equal(recoveredHeartbeat.status, 200);
  recoveryBootstrap = await (await api(testApp.baseUrl, cookie, "/api/bootstrap")).json();
  const recoveredHost = recoveryBootstrap.hosts.find((host) => host.id === created.host.id);
  assert.equal(recoveredHost.status, "online");
  assert.equal(recoveredHost.telemetry.networkRxBytes, null);
  assert.equal(
    testApp.app.store.db.prepare(
      "SELECT COUNT(*) AS count FROM host_metric_samples WHERE host_id = ?"
    ).get(created.host.id).count,
    1
  );
});

test("admin can replace a lost enrollment token before the remote host enrolls", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const createResponse = await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "伦敦备用机",
      address: "london.example.com",
      region: "london"
    })
  });
  const created = await createResponse.json();
  const rotateResponse = await api(
    testApp.baseUrl,
    cookie,
    `/api/hosts/${created.host.id}/enrollment-token`,
    { method: "POST" }
  );
  assert.equal(rotateResponse.status, 201);
  const rotated = await rotateResponse.json();
  assert.notEqual(rotated.enrollmentToken, created.enrollmentToken);

  const oldTokenResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: created.enrollmentToken })
  });
  assert.equal(oldTokenResponse.status, 401);
  const enrollResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: rotated.enrollmentToken, hostname: "london-vps" })
  });
  assert.equal(enrollResponse.status, 201);

  const enrolledRotationResponse = await api(
    testApp.baseUrl,
    cookie,
    `/api/hosts/${created.host.id}/enrollment-token`,
    { method: "POST" }
  );
  assert.equal(enrolledRotationResponse.status, 409);
});

test("control plane rate limits authenticated node heartbeat writes", async (t) => {
  const testApp = await startTestApp({ nodeHeartbeatMinIntervalMs: 5_000 });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const created = await (await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "限速测试节点",
      address: "rate-limit.example.com",
      region: "singapore"
    })
  })).json();
  const enrolled = await (await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "rate-limit-vps",
      agentVersion: "0.2.0",
      runtimeVersion: "1.13.12"
    })
  })).json();
  const headers = {
    authorization: `Bearer ${enrolled.nodeSecret}`,
    "content-type": "application/json",
    "x-raylink-host-id": enrolled.hostId
  };

  const first = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ telemetry: { serviceStatus: "running" } })
  });
  const second = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ telemetry: { serviceStatus: "running" } })
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, "HEARTBEAT_RATE_LIMITED");
});

test("user subscription includes every online host allowed by the user node scope", async (t) => {
  const testApp = await startTestApp({ proxyHost: "tokyo.example.com", listenPort: 8388 });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const createResponse = await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "法兰克福二号机",
      address: "fra.example.com",
      region: "frankfurt"
    })
  });
  const created = await createResponse.json();
  const enrollResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "fra-vps-02",
      platform: "linux",
      architecture: "x64",
      agentVersion: "0.7.0",
      runtimeVersion: "1.13.12"
    })
  });
  assert.equal(enrollResponse.status, 201);
  const nodeCredential = await enrollResponse.json();
  await enableHostShadowsocks(testApp.baseUrl, cookie, nodeCredential.hostId);

  const portalLogin = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = portalLogin.headers.getSetCookie()[0].split(";")[0];
  const beforePublishResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });
  assert.equal(beforePublishResponse.status, 200);
  assert.deepEqual(
    (await beforePublishResponse.json()).outbounds
      .filter((outbound) => outbound.type === "shadowsocks")
      .map((outbound) => outbound.server),
    ["tokyo.example.com"]
  );

  const publishResponse = await api(testApp.baseUrl, cookie, "/api/deployments", { method: "POST" });
  assert.equal(publishResponse.status, 201);
  const nodeHeaders = {
    authorization: `Bearer ${nodeCredential.nodeSecret}`,
    "x-raylink-host-id": nodeCredential.hostId
  };
  const taskResponse = await fetch(`${testApp.baseUrl}/api/node/tasks/next`, { headers: nodeHeaders });
  const task = await taskResponse.json();
  const completionResponse = await fetch(
    `${testApp.baseUrl}/api/node/tasks/${encodeURIComponent(task.id)}/complete`,
    {
      method: "POST",
      headers: { ...nodeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        attempt: task.attempt,
        status: "succeeded",
        result: { runtimeVersion: "1.13.12" }
      })
    }
  );
  assert.equal(completionResponse.status, 200);
  const heartbeatResponse = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers: { ...nodeHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      runtimeState: "running",
      telemetry: {
        cpuPercent: 10,
        memoryUsedBytes: 1_000,
        memoryTotalBytes: 2_000,
        networkRxBytes: 1_000,
        networkTxBytes: 1_000,
        networkRxBps: 0,
        networkTxBps: 0,
        serviceStatus: "running"
      }
    })
  });
  assert.equal(heartbeatResponse.status, 200);

  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });

  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  const servers = config.outbounds
    .filter((outbound) => outbound.type === "shadowsocks")
    .map((outbound) => outbound.server);
  assert.deepEqual(servers, ["tokyo.example.com", "fra.example.com"]);
});

test("old RayLink Nodes cannot claim tasks until their heartbeat reports the required version", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const created = await (await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "升级验证节点",
      address: "upgrade.example.com",
      region: "singapore"
    })
  })).json();
  const enrolled = await (await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "upgrade-node",
      agentVersion: "0.2.0",
      runtimeVersion: "1.13.12"
    })
  })).json();
  const nodeHeaders = {
    authorization: `Bearer ${enrolled.nodeSecret}`,
    "x-raylink-host-id": enrolled.hostId
  };

  await api(testApp.baseUrl, cookie, "/api/deployments", { method: "POST" });
  const blockedResponse = await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  });
  assert.equal(blockedResponse.status, 426);
  const blocked = await blockedResponse.json();
  assert.equal(blocked.error.code, "NODE_UPGRADE_REQUIRED");
  assert.equal(blocked.requiredVersion, "0.7.0");

  const beforeUpgrade = await (await api(testApp.baseUrl, cookie, "/api/bootstrap")).json();
  const waitingHost = beforeUpgrade.hosts.find((host) => host.id === enrolled.hostId);
  assert.equal(waitingHost.deploymentSync.pendingTaskCount, 1);

  const heartbeatResponse = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers: { ...nodeHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      agentVersion: "0.7.0",
      runtimeVersion: "1.13.12",
      telemetry: { serviceStatus: "running" }
    })
  });
  assert.equal(heartbeatResponse.status, 200);

  const taskResponse = await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  });
  assert.equal(taskResponse.status, 200);
  assert.equal((await taskResponse.json()).attempt, 1);
});

test("publishing queues a host-specific sing-box configuration for an enrolled RayLink Node", async (t) => {
  const runtimeAdapter = {
    async publish() {
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    },
    async status() {
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    }
  };
  const testApp = await startTestApp({ runtimeAdapter });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const createResponse = await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "法兰克福二号机",
      address: "fra-2.example.com",
      region: "frankfurt"
    })
  });
  const created = await createResponse.json();
  const enrollResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "fra-vps-02",
      platform: "linux",
      architecture: "amd64",
      agentVersion: "0.7.0",
      runtimeVersion: "1.13.12"
    })
  });
  const enrolled = await enrollResponse.json();
  await enableHostShadowsocks(testApp.baseUrl, cookie, enrolled.hostId);
  const nodeHeaders = {
    authorization: `Bearer ${enrolled.nodeSecret}`,
    "x-raylink-host-id": enrolled.hostId
  };

  const publishResponse = await api(testApp.baseUrl, cookie, "/api/deployments", {
    method: "POST"
  });
  assert.equal(publishResponse.status, 201);
  assert.equal((await publishResponse.json()).remoteQueued, 1);

  const taskResponse = await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  });
  assert.equal(taskResponse.status, 200);
  const task = await taskResponse.json();
  assert.equal(task.kind, "publish-config");
  assert.match(task.payload.version, /^v/);
  const config = JSON.parse(task.payload.configText);
  assert.equal(config.inbounds[0].users.length, 2);
  assert.equal(config.inbounds[0].users[0].name, "priya@vantage-bioworks.in");
  assert.equal(config.inbounds[0].users[1].name, "raylink-probe@internal");

  const completionResponse = await fetch(`${testApp.baseUrl}/api/node/tasks/${task.id}/complete`, {
    method: "POST",
    headers: { ...nodeHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      attempt: task.attempt,
      status: "succeeded",
      runtimeVersion: "1.13.12",
      validation: "sing-box"
    })
  });
  assert.equal(completionResponse.status, 200);

  const emptyResponse = await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  });
  assert.equal(emptyResponse.status, 204);
});

test("remote entitlement revocation is critical, retryable and visible until applied", async (t) => {
  const runtimeAdapter = {
    async publish() {
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    },
    async status() {
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    }
  };
  const testApp = await startTestApp({ runtimeAdapter, nodeTaskRetryBaseMs: 0 });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const created = await (await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "撤权验证节点",
      address: "revoke.example.com",
      region: "tokyo"
    })
  })).json();
  const enrolled = await (await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "revoke-node",
      platform: "linux",
      architecture: "amd64",
      agentVersion: "0.7.0",
      runtimeVersion: "1.13.12"
    })
  })).json();
  await enableHostShadowsocks(testApp.baseUrl, cookie, enrolled.hostId);
  const nodeHeaders = {
    authorization: `Bearer ${enrolled.nodeSecret}`,
    "x-raylink-host-id": enrolled.hostId
  };

  await api(testApp.baseUrl, cookie, "/api/deployments", { method: "POST" });
  const initialTask = await (await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  })).json();
  await fetch(`${testApp.baseUrl}/api/node/tasks/${initialTask.id}/complete`, {
    method: "POST",
    headers: { ...nodeHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      attempt: initialTask.attempt,
      status: "succeeded",
      runtimeVersion: "1.13.12"
    })
  });

  const beforeDisable = await (await api(testApp.baseUrl, cookie, "/api/bootstrap")).json();
  const priya = beforeDisable.users.find((user) => user.email === "priya@vantage-bioworks.in");
  const disableResponse = await api(testApp.baseUrl, cookie, `/api/users/${priya.id}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "disabled" })
  });
  assert.equal(disableResponse.status, 200);

  const revocationTask = await (await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  })).json();
  assert.equal(revocationTask.priority, "critical");
  assert.equal(revocationTask.attempt, 1);
  assert.doesNotMatch(revocationTask.payload.configText, /priya@vantage-bioworks\.in/);

  const failedCompletion = await fetch(
    `${testApp.baseUrl}/api/node/tasks/${revocationTask.id}/complete`,
    {
      method: "POST",
      headers: { ...nodeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        attempt: revocationTask.attempt,
        status: "failed",
        error: "temporary systemd failure"
      })
    }
  );
  assert.equal(failedCompletion.status, 200);
  assert.equal((await failedCompletion.json()).status, "pending");

  const retryTask = await (await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  })).json();
  assert.equal(retryTask.id, revocationTask.id);
  assert.equal(retryTask.attempt, 2);
  await fetch(`${testApp.baseUrl}/api/node/tasks/${retryTask.id}/complete`, {
    method: "POST",
    headers: { ...nodeHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      attempt: retryTask.attempt,
      status: "failed",
      error: "still unavailable"
    })
  });

  await api(testApp.baseUrl, cookie, "/api/deployments", { method: "POST" });
  const replacementTask = await (await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  })).json();
  assert.notEqual(replacementTask.id, retryTask.id);
  assert.equal(replacementTask.priority, "critical");
  assert.doesNotMatch(replacementTask.payload.configText, /priya@vantage-bioworks\.in/);
  await fetch(`${testApp.baseUrl}/api/node/tasks/${replacementTask.id}/complete`, {
    method: "POST",
    headers: { ...nodeHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      attempt: replacementTask.attempt,
      status: "succeeded",
      runtimeVersion: "1.13.12"
    })
  });
  const staleCompletion = await fetch(
    `${testApp.baseUrl}/api/node/tasks/${replacementTask.id}/complete`,
    {
      method: "POST",
      headers: { ...nodeHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        attempt: replacementTask.attempt - 1,
        status: "failed",
        error: "late callback from an older lease"
      })
    }
  );
  assert.equal((await staleCompletion.json()).ignored, true);

  const afterRetry = await (await api(testApp.baseUrl, cookie, "/api/bootstrap")).json();
  const remoteHost = afterRetry.hosts.find((host) => host.id === enrolled.hostId);
  assert.equal(remoteHost.deploymentSync.pendingTaskCount, 0);

  await api(testApp.baseUrl, cookie, `/api/users/${priya.id}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "active" })
  });
  const expansionTask = await (await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  })).json();
  assert.equal(expansionTask.priority, "normal");
  assert.match(expansionTask.payload.configText, /priya@vantage-bioworks\.in/);
});

test("narrowing a User node scope republishes a remote-only Runtime Credential revocation", async (t) => {
  const runtimeAdapter = {
    async publish() {
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    },
    async status() {
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    }
  };
  const testApp = await startTestApp({ runtimeAdapter });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const created = await (await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "Singapore scope verification",
      address: "scope.example.com",
      region: "singapore"
    })
  })).json();
  const enrolled = await (await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "scope-node",
      platform: "linux",
      architecture: "amd64",
      agentVersion: "0.7.0",
      runtimeVersion: "1.13.12"
    })
  })).json();
  await enableHostShadowsocks(testApp.baseUrl, cookie, enrolled.hostId);
  const nodeHeaders = {
    authorization: `Bearer ${enrolled.nodeSecret}`,
    "x-raylink-host-id": enrolled.hostId
  };

  await api(testApp.baseUrl, cookie, "/api/deployments", { method: "POST" });
  const initialTask = await (await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  })).json();
  assert.match(initialTask.payload.configText, /priya@vantage-bioworks\.in/);
  await fetch(`${testApp.baseUrl}/api/node/tasks/${initialTask.id}/complete`, {
    method: "POST",
    headers: { ...nodeHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      attempt: initialTask.attempt,
      status: "succeeded",
      runtimeVersion: "1.13.12"
    })
  });

  const bootstrap = await (await api(testApp.baseUrl, cookie, "/api/bootstrap")).json();
  const priya = bootstrap.users.find((user) => user.email === "priya@vantage-bioworks.in");
  const updateResponse = await api(testApp.baseUrl, cookie, `/api/users/${priya.id}`, {
    method: "PATCH",
    body: JSON.stringify({ nodeScope: ["tokyo"] })
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).runtimeSync.status, "published");

  const revocationResponse = await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  });
  assert.equal(revocationResponse.status, 200);
  const revocationTask = await revocationResponse.json();
  assert.equal(revocationTask.priority, "critical");
  assert.doesNotMatch(revocationTask.payload.configText, /priya@vantage-bioworks\.in/);
});

test("revoking portal access invalidates an existing user session", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const portalLogin = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = portalLogin.headers.getSetCookie()[0].split(";")[0];
  const adminCookie = await login(testApp.baseUrl);
  const bootstrapResponse = await api(testApp.baseUrl, adminCookie, "/api/bootstrap");
  const bootstrap = await bootstrapResponse.json();
  const user = bootstrap.users.find((candidate) => candidate.email === "priya@vantage-bioworks.in");
  await api(testApp.baseUrl, adminCookie, `/api/users/${user.id}`, {
    method: "PATCH",
    body: JSON.stringify({ portalStatus: "invited" })
  });

  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });
  assert.equal(configResponse.status, 403);
  assert.equal((await configResponse.json()).error.code, "ACCOUNT_NOT_ACTIVE");
});

test("portal refuses a client config when the user entitlement excludes the runtime region", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const adminCookie = await login(testApp.baseUrl);
  const bootstrapResponse = await api(testApp.baseUrl, adminCookie, "/api/bootstrap");
  const bootstrap = await bootstrapResponse.json();
  const user = bootstrap.users.find((candidate) => candidate.email === "priya@vantage-bioworks.in");
  await api(testApp.baseUrl, adminCookie, `/api/users/${user.id}`, {
    method: "PATCH",
    body: JSON.stringify({ nodeScope: ["frankfurt"] })
  });
  const portalLogin = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = portalLogin.headers.getSetCookie()[0].split(";")[0];
  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });
  assert.equal(configResponse.status, 403);
  assert.equal((await configResponse.json()).error.code, "ENTITLEMENT_INACTIVE");
});

test("recorded usage at the user quota removes the user from runtime and blocks config download", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const adminCookie = await login(testApp.baseUrl);
  const bootstrapResponse = await api(testApp.baseUrl, adminCookie, "/api/bootstrap");
  const bootstrap = await bootstrapResponse.json();
  const user = bootstrap.users.find((candidate) => candidate.email === "priya@vantage-bioworks.in");

  const updateResponse = await api(testApp.baseUrl, adminCookie, `/api/users/${user.id}`, {
    method: "PATCH",
    body: JSON.stringify({ usedGb: 320 })
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).usedGb, 320);

  const previewResponse = await api(testApp.baseUrl, adminCookie, "/api/deployments/preview", {
    method: "POST"
  });
  assert.equal((await previewResponse.json()).eligibleUsers, 4);

  const portalLogin = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = portalLogin.headers.getSetCookie()[0].split(";")[0];
  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });
  assert.equal(configResponse.status, 403);
  assert.equal((await configResponse.json()).error.code, "ENTITLEMENT_INACTIVE");
});

test("RayLink Node reports real cumulative user counters idempotently and enforces quota", async (t) => {
  const testApp = await startTestApp({ seedDemoData: false });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const userResponse = await api(testApp.baseUrl, cookie, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "Usage User",
      email: "usage@example.com",
      password: "password-123",
      portalStatus: "active",
      state: "active",
      quotaGb: 1,
      nodeScope: ["singapore"],
      clientFormats: ["sing-box"],
      expiresAt: "2027-01-01"
    })
  });
  assert.ok([201, 202].includes(userResponse.status));
  const user = await userResponse.json();
  const hostResponse = await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "Usage Host",
      address: "usage.example.com",
      region: "singapore"
    })
  });
  const createdHost = await hostResponse.json();
  const enrolled = await (await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: createdHost.enrollmentToken,
      agentVersion: "0.7.0",
      runtimeVersion: "1.14.2",
      buildTags: ["with_v2ray_api"]
    })
  })).json();
  const nodeHeaders = {
    "content-type": "application/json",
    authorization: `Bearer ${enrolled.nodeSecret}`,
    "x-raylink-host-id": enrolled.hostId
  };
  const initialDeployment = await api(testApp.baseUrl, cookie, "/api/deployments", {
    method: "POST",
    body: JSON.stringify({})
  });
  assert.equal(initialDeployment.status, 201);
  const failedStatus = await fetch(`${testApp.baseUrl}/api/node/usage/status`, {
    method: "POST",
    headers: nodeHeaders,
    body: JSON.stringify({ status: "error", error: "stats endpoint unavailable" })
  });
  assert.equal(failedStatus.status, 200);
  assert.equal((await failedStatus.json()).usageMetering.status, "error");
  const usage = {
    sampleId: "usage-sample-0001",
    runtimeInstanceId: "runtime-instance-0001",
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    users: [{
      name: user.email,
      uplinkBytes: 400 * 1024 ** 2,
      downlinkBytes: 700 * 1024 ** 2
    }]
  };
  const first = await fetch(`${testApp.baseUrl}/api/node/usage`, {
    method: "POST",
    headers: nodeHeaders,
    body: JSON.stringify(usage)
  });
  const firstBody = await first.clone().json();
  assert.equal(first.status, 200, JSON.stringify(firstBody));
  const result = await first.json();
  assert.equal(result.appliedBytes, 1_100 * 1024 ** 2);
  assert.deepEqual(result.quotaExceededUserIds, [user.id]);
  assert.equal(result.runtimeSync.status, "published");
  assert.equal(testApp.app.store.getHost(enrolled.hostId).usageMetering.status, "healthy");

  const revocationTaskResponse = await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: {
      authorization: `Bearer ${enrolled.nodeSecret}`,
      "x-raylink-host-id": enrolled.hostId
    }
  });
  assert.equal(revocationTaskResponse.status, 200);
  const revocationTask = await revocationTaskResponse.json();
  assert.equal(revocationTask.kind, "publish-config");
  assert.equal(revocationTask.priority, "critical");
  assert.equal(revocationTask.payload.configText.includes(user.email), false);

  const duplicate = await fetch(`${testApp.baseUrl}/api/node/usage`, {
    method: "POST",
    headers: nodeHeaders,
    body: JSON.stringify(usage)
  });
  assert.equal((await duplicate.json()).duplicate, true);
  assert.ok(testApp.app.store.getUser(user.id).usedGb > 1);
});

test("control plane serves the RayLink web application on the same origin", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());

  const indexResponse = await fetch(`${testApp.baseUrl}/`);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get("content-type"), /text\/html/);
  const indexHtml = await indexResponse.text();
  assert.match(indexHtml, /用户管理/);
  assert.match(indexHtml, /<th>订阅<\/th>/);
  assert.doesNotMatch(indexHtml, /方案管理/);
  assert.match(indexHtml, /通用订阅/);
  assert.doesNotMatch(indexHtml, /节点 \/ 客户端/);
  assert.doesNotMatch(indexHtml, /节点和客户端能力/);
  assert.match(indexHtml, /网络流量趋势/);
  assert.match(indexHtml, /dashboard-network-trend/);
  assert.match(indexHtml, /节点运行情况/);
  assert.match(indexHtml, /dashboard-node-health-grid/);
  assert.match(indexHtml, /来自 RayLink Node 的真实遥测/);
  assert.match(indexHtml, /安全升级/);
  assert.match(indexHtml, /data-check-runtime-update/);
  assert.doesNotMatch(indexHtml, /按启用账号数量缩放趋势样例/);
  assert.match(indexHtml, /assets\/brand\/raylink-mark\.svg\?v=20260726/);
  assert.doesNotMatch(indexHtml, /class="brand-mark[^"]*"[^>]*>R\/<\/span>/);
  assert.match(indexHtml, /id="profile-menu"/);
  assert.match(indexHtml, /data-logout/);
  assert.match(indexHtml, /aria-controls="profile-menu"/);
  assert.doesNotMatch(indexHtml, /role="menu(item)?"/);
  assert.match(indexHtml, /class="mobile-nav"[^>]*hidden/);
  assert.match(indexHtml, /id="host-topology"/);
  assert.doesNotMatch(indexHtml, /route-one/);

  const scriptResponse = await fetch(`${testApp.baseUrl}/app.js`);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type"), /javascript/);
  const appScript = await scriptResponse.text();
  assert.doesNotMatch(appScript, /priya@vantage-bioworks\.in/);
  assert.match(appScript, /通用订阅/);
  assert.doesNotMatch(appScript, /种客户端格式/);
  assert.doesNotMatch(appScript, /客户端能力由管理员/);
  assert.match(appScript, /assets\/brand\/raylink-mark\.svg\?v=20260726/);
  assert.doesNotMatch(appScript, /class="brand-mark[^"]*"[^>]*>R\/<\/span>/);
  assert.match(appScript, /api\("\/api\/auth\/logout"/);
  assert.match(appScript, /renderHostTopology/);
  assert.match(appScript, /data-topology-host=/);
  assert.match(appScript, /data-topology-link=/);
  assert.match(appScript, /data-user-subscription-action/);
  assert.match(appScript, /data-user-subscription-qr/);
  assert.match(appScript, /data-user-subscription-quick/);
  assert.match(appScript, /openUserSubscriptionQuick/);
  assert.match(appScript, /subscriptionQuick\.reveal/);
  assert.match(appScript, /\/api\/users\/\$\{encodeURIComponent\(userId\)\}\/subscription/);
  assert.match(appScript, /subscriptionSession\.clear\(\)/);
  assert.match(appScript, /hydrateUserSubscriptionPanel/);
  assert.match(appScript, /data-reset-user-password/);
  assert.match(appScript, /重置用户中心密码/);
  assert.match(appScript, /重置后所有已登录设备需要重新登录/);
  assert.match(appScript, /data-subscription-format="mihomo"/);
  assert.match(appScript, /data-subscription-format="egern-profile"/);
  assert.match(appScript, /data-subscription-format="egern"/);
  assert.match(appScript, /Egern 完整配置/);
  assert.match(appScript, /Egern 节点订阅/);
  assert.match(appScript, /Clash \/ Mihomo/);
  assert.match(appScript, /Egern/);
  assert.doesNotMatch(appScript, /profile\.enabled \|\| oneClick/);
  assert.match(appScript, /protocolDrawerMarkup\(hostId, protocolType\)/);
  assert.doesNotMatch(appScript, /protocolLabels\.slice\(0,\s*3\)/);
  assert.match(appScript, /class="host-protocol-tags"/);
  assert.match(appScript, /data-measure-host-latency/);
  assert.match(appScript, /protocolHealth\.present/);
  assert.match(appScript, /protocol-latency-value/);
  const styleResponse = await fetch(`${testApp.baseUrl}/styles.css`);
  assert.equal(styleResponse.status, 200);
  const styles = await styleResponse.text();
  assert.match(styles, /\.host-protocol-tags\s*\{/);
  assert.match(styles, /flex-wrap:\s*wrap/);
  assert.match(indexHtml, /src="\.\/qrcode\.min\.js/);
  assert.match(indexHtml, /src="\.\/subscription-qr\.js/);
  assert.match(indexHtml, /src="\.\/subscription-session\.js/);
  assert.match(indexHtml, /src="\.\/subscription-quick\.js/);
  assert.match(indexHtml, /src="\.\/protocol-health\.js/);
  assert.ok(indexHtml.includes(`app.js?v=${packageVersion}`));

  const subscriptionSessionResponse = await fetch(
    `${testApp.baseUrl}/subscription-session.js`
  );
  assert.equal(subscriptionSessionResponse.status, 200);
  assert.match(
    subscriptionSessionResponse.headers.get("content-type"),
    /javascript/
  );
  const subscriptionQuickResponse = await fetch(
    `${testApp.baseUrl}/subscription-quick.js`
  );
  assert.equal(subscriptionQuickResponse.status, 200);
  assert.match(
    subscriptionQuickResponse.headers.get("content-type"),
    /javascript/
  );
  const universalPortalResponse = await fetch(`${testApp.baseUrl}/portal`);
  assert.equal(universalPortalResponse.status, 200);
  const universalPortalHtml = await universalPortalResponse.text();
  assert.match(universalPortalHtml, /id="portal-import-mihomo"/);
  assert.match(universalPortalHtml, /id="portal-import-egern"/);
  assert.match(universalPortalHtml, /id="portal-download-singbox"/);
  assert.doesNotMatch(universalPortalHtml, /客户端能力由管理员/);
  const portalScriptResponse = await fetch(`${testApp.baseUrl}/portal.js`);
  assert.equal(portalScriptResponse.status, 200);
  const portalScript = await portalScriptResponse.text();
  assert.match(portalScript, /clash:\/\/install-config/);
  assert.match(portalScript, /egern:\/profiles\/new/);
  const protocolHealthResponse = await fetch(
    `${testApp.baseUrl}/protocol-health.js`
  );
  assert.equal(protocolHealthResponse.status, 200);
  assert.match(protocolHealthResponse.headers.get("content-type"), /javascript/);
  assert.match(await protocolHealthResponse.text(), /RayLinkProtocolHealth/);

  const logoResponse = await fetch(
    `${testApp.baseUrl}/assets/brand/raylink-mark.svg`
  );
  assert.equal(logoResponse.status, 200);
  assert.match(logoResponse.headers.get("content-type"), /image\/svg\+xml/);
  const logoSvg = await logoResponse.text();
  assert.match(logoSvg, /aria-labelledby="raylink-mark-title"/);
  assert.match(logoSvg, /viewBox="0 0 64 64"/);

  const setupResponse = await fetch(`${testApp.baseUrl}/setup`);
  assert.equal(setupResponse.status, 200);
  const setupHtml = await setupResponse.text();
  assert.match(setupHtml, /assets\/brand\/raylink-mark\.svg\?v=20260726/);
  assert.doesNotMatch(setupHtml, /class="brand-mark[^"]*"[^>]*>R\/<\/span>/);

  const nodeInstallerResponse = await fetch(`${testApp.baseUrl}/node/install.sh`);
  assert.equal(nodeInstallerResponse.status, 200);
  assert.match(nodeInstallerResponse.headers.get("content-type"), /text\/plain/);
  const nodeInstaller = await nodeInstallerResponse.text();
  assert.match(nodeInstaller, /raylink-node\.service/);
  assert.match(nodeInstaller, /build-metered-runtime\.sh/);
  assert.match(
    nodeInstaller,
    /node\/runtime\/\$runtime_name/
  );
  assert.match(nodeInstaller, /node\/runtime\/\$cronet_name/);
  assert.match(nodeInstaller, /\$RAYLINK_RUNTIME_BIN_DIR\/libcronet\.so/);
  assert.match(nodeInstaller, /atomic_install 0755 "\$runtime_candidate" "\$sing_box_bin"/);
  assert.match(nodeInstaller, /回退到本机编译/);
  assert.match(nodeInstaller, /sha256sum -c/);
  assert.match(nodeInstaller, /with_naive_outbound/);
  assert.match(nodeInstaller, /with_v2ray_api/);
  assert.match(nodeInstaller, /\^http:\/\/\(127\\\.0\\\.0\\\.1\|localhost\|\\\[::1\\\]\)/);
  assert.match(nodeInstaller, /systemctl is-active --quiet sing-box\.service/);
  assert.doesNotMatch(nodeInstaller, /systemctl disable sing-box\.service/);
  assert.doesNotMatch(nodeInstaller, /disable --now sing-box\.service/);
  assert.doesNotMatch(nodeInstaller, /sing-box\.app\/install\.sh/);
  const meteredBuilderResponse = await fetch(
    `${testApp.baseUrl}/node/build-metered-runtime.sh`
  );
  assert.equal(meteredBuilderResponse.status, 200);
  const meteredBuilder = await meteredBuilderResponse.text();
  assert.match(meteredBuilder, /with_v2ray_api/);
  assert.match(meteredBuilder, /sha256sum -c/);

  const firewallTmpfilesResponse = await fetch(
    `${testApp.baseUrl}/node/raylink-ufw.tmpfiles.conf`
  );
  assert.equal(firewallTmpfilesResponse.status, 200);
  const firewallTmpfiles = await firewallTmpfilesResponse.text();
  assert.match(firewallTmpfiles, /^f \/run\/ufw\.lock 0644 root root -$/m);
  assert.match(firewallTmpfiles, /^f \/run\/xtables\.lock 0600 root root -$/m);

  const nodeUpgradeResponse = await fetch(`${testApp.baseUrl}/node/upgrade.sh`);
  assert.equal(nodeUpgradeResponse.status, 200);
  assert.equal(await nodeUpgradeResponse.text(), readFileSync(new URL("../web/node/upgrade.sh", import.meta.url), "utf8"));
  const nodeRuntimeResponse = await fetch(`${testApp.baseUrl}/node/raylink-node.mjs`);
  assert.equal(nodeRuntimeResponse.status, 200);
  assert.match(nodeRuntimeResponse.headers.get("content-type"), /javascript/);
  const nodeRuntime = await nodeRuntimeResponse.text();
  assert.match(nodeRuntime, /class RayLinkNode/);
  assert.match(nodeRuntime, /AGENT_VERSION = "0\.9\.0"/);
  assert.match(nodeRuntime, /upgrade-runtime/);

  const portalResponse = await fetch(`${testApp.baseUrl}/portal/`);
  assert.equal(portalResponse.status, 200);
  const portalHtml = await portalResponse.text();
  assert.match(portalHtml, /查看我的网络服务/);
  assert.match(portalHtml, /id="portal-subscription-action"/);
  assert.match(portalHtml, /id="portal-subscription-url"/);
  assert.match(portalHtml, /assets\/brand\/raylink-mark\.svg\?v=20260726/);
  assert.doesNotMatch(portalHtml, /class="brand-mark[^"]*"[^>]*>R\/<\/span>/);
  assert.match(portalHtml, /id="portal-copy-subscription"/);
  assert.match(portalHtml, /id="portal-subscription-qr"/);
  assert.match(portalHtml, /TUN 需要系统 VPN 权限/);
  assert.match(portalHtml, /mixed 回退/);
  assert.match(portalHtml, /删除订阅/);
  assert.match(portalHtml, /href="\/styles\.css(?:\?[^"]*)?"/);
  assert.match(portalHtml, /src="\/qrcode\.min\.js/);
  assert.match(portalHtml, /src="\/subscription-qr\.js/);
  assert.match(portalHtml, /src="\/portal\.js(?:\?[^"]*)?"/);

  const qrScriptResponse = await fetch(`${testApp.baseUrl}/qrcode.min.js`);
  assert.equal(qrScriptResponse.status, 200);
  assert.match(qrScriptResponse.headers.get("content-type"), /javascript/);
  assert.match(await qrScriptResponse.text(), /QRCode/);

  const subscriptionQrResponse = await fetch(
    `${testApp.baseUrl}/subscription-qr.js`
  );
  assert.equal(subscriptionQrResponse.status, 200);
  assert.match(await subscriptionQrResponse.text(), /RayLinkSubscriptionQr/);
});
