import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRayLinkApp } from "../server/app.js";
import { hashSessionSecret } from "../server/security.js";

const ownerPassword = "security-owner-password";
const userPassword = "security-user-password";

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-auth-security-"));
  const app = await createRayLinkApp({
    dataDir, adminUsername: "owner", adminPassword: ownerPassword,
    publicOrigin: "http://127.0.0.1", runtimeMode: "dry-run", seedDemoData: false,
    singBoxBinary: join(dataDir, "missing-runtime"), backupIntervalMs: 0, alertIntervalMs: 0,
    runtimeUpdateCheckIntervalMs: 0, entitlementReconcileIntervalMs: 0, protocolLatencyIntervalMs: 0,
    tlsRenewalIntervalMs: 0,
    installer: { async status() { return { installed: false, tags: [] }; } },
    ruleSetCache: { prepare: async () => {}, available: () => false, get: async () => null },
    ...overrides
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = (path, { cookie = "", method = "GET", body, headers = {} } = {}) => fetch(`${base}${path}`, {
    method, headers: { cookie, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const adminCookie = (role) => {
    const admin = role === "owner" ? app.store.listAdmins()[0]
      : app.store.createAdmin({ username: role, password: ownerPassword, role });
    return `raylink_session=${app.store.createAdminSession(admin.id).secret}`;
  };
  const user = app.store.createUser({
    name: "Security User", email: "security-user@example.test", password: userPassword,
    portalStatus: "active", quotaGb: 10, expiresAt: "2099-01-01", nodeScope: ["all"]
  });
  return { app, api, adminCookie, user, base };
}

async function setupFixture(t) {
  const token = "security-setup-token";
  const f = await fixture(t, {
    setupRequired: true, setupTokenHash: hashSessionSecret(token),
    setupTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(), trustProxy: true,
    bbrManager: {
      async inspect() { return { status: "available" }; },
      async configure() { return { status: "enabled" }; }
    }
  });
  return { ...f, payload: {
    token,
    access: { mode: "ip", canonicalOrigin: f.base, allowedOrigins: [f.base] },
    certificate: { mode: "external" },
    admin: { username: "setup-owner", password: "Setup-Owner-Password-123" },
    runtime: { name: "Security Gateway", address: "127.0.0.1", region: "tokyo" }
  } };
}

test("malformed setup requests across sources do not exhaust initialization or login capacity", async (t) => {
  const f = await setupFixture(t);
  const malformed = [];
  const bodies = [...Array(20).fill(null), [], {}, { token: null }, { token: [f.payload.token] },
    { token: 42 }, { token: { value: f.payload.token } }];
  for (const [index, body] of bodies.entries()) {
    const path = index % 2 ? "/api/setup/complete" : "/api/setup/preflight";
    const response = await f.api(path, { method: "POST", body,
      headers: { "x-forwarded-for": `192.0.2.${index + 1}` } });
    malformed.push({ status: response.status, body: await response.json() });
  }
  const preflight = await f.api("/api/setup/preflight", { method: "POST", body: f.payload,
    headers: { "x-forwarded-for": "192.0.2.200" } });
  assert.equal(preflight.status, 200, "malformed requests must not retain global verification reservations");
  assert.ok(malformed.every(response => response.status === 422 && response.body.error.code === "INVALID_SETUP_INPUT"),
    `malformed setup bodies and tokens need validation responses, got ${malformed.map(response => response.status).join(",")}`);
  const completed = await f.api("/api/setup/complete", { method: "POST", body: f.payload,
    headers: { "x-forwarded-for": "192.0.2.201" } });
  assert.equal(completed.status, 201);
  assert.equal((await f.api("/api/auth/login", { method: "POST", body: f.payload.admin })).status, 200);
});

test("setup token verifier failures release capacity for initialization and subsequent login", async (t) => {
  const f = await setupFixture(t);
  const verifySetupToken = f.app.store.verifySetupToken.bind(f.app.store);
  const failures = [];
  f.app.store.verifySetupToken = () => { throw new Error("Synthetic setup token storage failure"); };
  try {
    for (let index = 0; index < 20; index += 1) {
      const path = index % 2 ? "/api/setup/complete" : "/api/setup/preflight";
      failures.push((await f.api(path, { method: "POST", body: f.payload,
        headers: { "x-forwarded-for": `198.51.100.${index + 1}` } })).status);
    }
  } finally { f.app.store.verifySetupToken = verifySetupToken; }
  const preflight = await f.api("/api/setup/preflight", { method: "POST", body: f.payload,
    headers: { "x-forwarded-for": "198.51.100.200" } });
  assert.equal(preflight.status, 200, "verification exceptions must release every global reservation");
  assert.deepEqual(failures, Array(20).fill(500));
  const completed = await f.api("/api/setup/complete", { method: "POST", body: f.payload,
    headers: { "x-forwarded-for": "198.51.100.201" } });
  assert.equal(completed.status, 201);
  assert.equal((await f.api("/api/auth/login", { method: "POST", body: f.payload.admin })).status, 200);
});

test("auditors retain a safe REST overview but cannot retrieve subscription credentials", async (t) => {
  const f = await fixture(t);
  f.app.store.rotateUserSubscription(f.user.id);
  const privateKey = Buffer.alloc(32, 7).toString("base64url");
  f.app.store.updateHostProtocolConfig("local", "vless", { enabled: false, tls: {
    mode: "reality", serverName: "www.example.com", handshakeServer: "www.example.com",
    handshakePort: 443, privateKey, publicKey: Buffer.alloc(32, 8).toString("base64url"), shortId: "aabbccdd"
  } });
  const auditor = f.adminCookie("auditor");
  const subscription = await f.api(`/api/users/${f.user.id}/subscription`, { cookie: auditor });
  assert.equal(subscription.status, 403);
  assert.equal((await subscription.json()).error.code, "FORBIDDEN");
  const overview = await f.api("/api/bootstrap", { cookie: auditor });
  assert.equal(overview.status, 200);
  const body = await overview.json();
  assert.equal(body.users[0].id, f.user.id);
  assert.equal(body.hosts[0].id, "local");
  assert.ok(!JSON.stringify(body).includes(privateKey));
  assert.equal(body.hosts[0].protocols.find(profile => profile.type === "vless").tls.mode, "reality");
  assert.equal(body.runtimePreview.eligibleUsers, 1);
  const ownerOverview = await (await f.api("/api/bootstrap", { cookie: f.adminCookie("owner") })).json();
  assert.equal(ownerOverview.hosts[0].protocols.find(profile => profile.type === "vless").tls.privateKey, privateKey);
  assert.equal((await f.api(`/api/users/${f.user.id}/subscription`, { cookie: f.adminCookie("support") })).status, 200);
});

test("resetting a portal password rejects an old-password login already being verified", async (t) => {
  const f = await fixture(t);
  const authenticate = f.app.store.authenticateUser.bind(f.app.store);
  let verificationStarted;
  const started = new Promise(resolve => { verificationStarted = resolve; });
  f.app.store.authenticateUser = (...args) => {
    // Preserve the real asynchronous scrypt operation and only observe when it
    // starts, so the reset happens while the original password is in flight.
    const result = authenticate(...args);
    verificationStarted();
    return result;
  };
  const inFlight = f.api("/api/portal/login", { method: "POST", body: { email: f.user.email, password: userPassword } });
  await started;
  const reset = f.app.store.resetUserPassword(f.user.id, "replacement-user-password");
  assert.equal(reset.passwordReset, true);
  const oldLogin = await inFlight;
  assert.equal(oldLogin.status, 401);
  assert.equal(oldLogin.headers.getSetCookie().length, 0);
  assert.equal((await f.api("/api/portal/login", { method: "POST", body: {
    email: f.user.email, password: "replacement-user-password"
  } })).status, 200);
});

for (const [path, body] of [
  ["/api/auth/login", { username: "missing-admin", password: "wrong-password" }],
  ["/api/portal/login", { email: "missing-user@example.test", password: "wrong-password" }]
]) {
  test(`${path} reserves the attempt budget before concurrent password verification`, async (t) => {
    const f = await fixture(t);
    const statuses = await Promise.all(Array.from({ length: 32 }, async () =>
      (await f.api(path, { method: "POST", body })).status));
    assert.equal(statuses.filter(status => status === 401).length, 8);
    assert.equal(statuses.filter(status => status === 429).length, 24);
    assert.equal((await f.api(path, { method: "POST", body })).status, 429);
  });
}

for (const accountShared of [false, true]) {
  test(`a successful concurrent login preserves in-flight ${accountShared ? "account" : "source"} reservations`, async (t) => {
    const f = await fixture(t, { trustProxy: true });
    const authenticate = f.app.store.authenticateAdmin.bind(f.app.store);
    let releaseOwner, releaseFailures, markStarted;
    const ownerGate = new Promise(resolve => { releaseOwner = resolve; });
    const failureGate = new Promise(resolve => { releaseFailures = resolve; });
    const started = new Promise(resolve => { markStarted = resolve; });
    let calls = 0;
    f.app.store.authenticateAdmin = (...args) => {
      const verification = authenticate(...args);
      calls += 1;
      if (calls === 8) markStarted();
      return verification.then(async result => { await (args[1] === ownerPassword ? ownerGate : failureGate); return result; });
    };
    t.after(() => { releaseOwner(); releaseFailures(); });
    let source = 1;
    const wrong = () => f.api("/api/auth/login", { method: "POST", body: {
      username: accountShared ? "owner" : "missing", password: "incorrect"
    }, ...(accountShared ? { headers: { "x-forwarded-for": `192.0.2.${source++}` } } : {}) });
    const good = f.api("/api/auth/login", { method: "POST", body: { username: "owner", password: ownerPassword } });
    const firstFailures = Array.from({ length: 7 }, wrong);
    await started;
    releaseOwner();
    assert.equal((await good).status, 200);
    const extra = Array.from({ length: 8 }, wrong);
    // Let every extra request reach the HTTP admission boundary while the original
    // failures stay in flight. Closing the gates then lets all requests finish.
    const denied = [];
    const responses = extra.map(async request => { const response = await request; if (response.status === 429) denied.push(response); return response; });
    const deadline = Date.now() + 5_000;
    try {
      while (denied.length < 7) {
        assert.ok(Date.now() < deadline, "extra requests should be rejected while the failures remain in flight");
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(calls, 9, "only the released success reservation can be reused");
    } finally { releaseFailures(); }
    const statuses = (await Promise.all(responses)).map(response => response.status);
    await Promise.all(firstFailures);
    assert.equal(statuses.filter(status => status === 401).length, 1);
    assert.equal(statuses.filter(status => status === 429).length, 7);
  });
}


test("password verification has a process-wide concurrency cap across client addresses", async (t) => {
  const f = await fixture(t, { trustProxy: true });
  const authenticate = f.app.store.authenticateAdmin.bind(f.app.store);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.app.store.authenticateAdmin = (...args) => authenticate(...args).then(async result => { await gate; return result; });
  let denied = 0;
  const requests = Array.from({ length: 32 }, (_, index) => f.api("/api/auth/login", {
    method: "POST", body: { username: `missing-${index}`, password: "incorrect" },
    headers: { "x-forwarded-for": `192.0.2.${index + 1}` }
  }).then(response => { if (response.status === 429) denied += 1; return response.status; }));
  const deadline = Date.now() + 5_000;
  try {
    while (denied < 16) {
      assert.ok(Date.now() < deadline, "excess concurrent verification should be rejected across source addresses");
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally { release(); }
  const statuses = await Promise.all(requests);
  assert.equal(statuses.filter(status => status === 401).length, 16);
  assert.equal(statuses.filter(status => status === 429).length, 16);
});

for (const [path, key, values] of [
  ["/api/auth/login", "username", ["owner", " OWNER ", "Owner"]],
  ["/api/portal/login", "email", ["security-user@example.test", " SECURITY-USER@EXAMPLE.TEST ", "Security-User@Example.Test"]]
]) {
  test(`${path} shares the normalized account budget across source addresses`, async (t) => {
    const f = await fixture(t, { trustProxy: true });
    const statuses = [];
    for (let source = 0; source < values.length; source += 1) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        statuses.push((await f.api(path, { method: "POST", body: { [key]: values[source], password: "incorrect" },
          headers: { "x-forwarded-for": `192.0.2.${source + 1}` }
        })).status);
      }
    }
    assert.equal(statuses.filter(status => status === 401).length, 8);
    assert.equal(statuses.filter(status => status === 429).length, 16);
  });
}

test("successful REST credential reads create one audit event without credential or query contents", async (t) => {
  const f = await fixture(t);
  f.app.store.rotateUserSubscription(f.user.id);
  const cookie = f.adminCookie("owner");
  const path = `/api/users/${f.user.id}/subscription`;
  const read = await f.api(`${path}?marker=private-query-marker`, { cookie });
  assert.equal(read.status, 200);
  const subscription = await read.json();
  assert.equal(typeof subscription.subscriptionUrl, "string");
  const audit = await (await f.api("/api/audit", { cookie })).json();
  const events = audit.events.filter(event => event.action === `GET ${path}`);
  assert.equal(events.length, 1);
  assert.equal(events[0].resourceType, "users");
  assert.equal(events[0].resourceId, f.user.id);
  assert.equal(events[0].metadata.statusCode, 200);
  assert.equal(events[0].metadata.sensitiveRead, true);
  assert.ok(!JSON.stringify(audit).includes(subscription.subscriptionUrl));
  assert.ok(!JSON.stringify(audit).includes("private-query-marker"));
});

test("array emails cannot bypass a locked account by clearing another account's shared key", async (t) => {
  const f = await fixture(t, { trustProxy: true });
  const attacker = f.app.store.createUser({ name: "Other User", email: "other-user@example.test",
    password: userPassword, portalStatus: "active", quotaGb: 10, expiresAt: "2099-01-01", nodeScope: ["all"] });
  const login = (email, password, source) => f.api("/api/portal/login", { method: "POST",
    body: { email, password }, headers: { "x-forwarded-for": `192.0.2.${source}` }
  });
  for (let index = 0; index < 8; index += 1) assert.equal((await login(f.user.email, "incorrect", 1)).status, 401);
  assert.equal((await login(f.user.email, "incorrect", 2)).status, 429);
  const attemptedBypass = [];
  for (let round = 0; round < 3; round += 1) {
    for (let index = 0; index < 7; index += 1) attemptedBypass.push(await login([f.user.email], "incorrect", round + 3));
    attemptedBypass.push(await login([attacker.email], userPassword, round + 3));
  }
  assert.ok(attemptedBypass.every(response => response.status === 422),
    `non-string identities must be rejected before authentication, got ${attemptedBypass.map(response => response.status).join(",")}`);
  assert.ok(attemptedBypass.every(response => response.headers.getSetCookie().length === 0));
  assert.equal((await login(attacker.email, userPassword, 6)).status, 200);
});

for (const [path, field, identity] of [
  ["/api/auth/login", "username", "owner"],
  ["/api/portal/login", "email", "security-user@example.test"]
]) {
  test(`${path} rejects non-object bodies and non-string credentials with a validation response`, async (t) => {
    const f = await fixture(t);
    const bodies = [null, [], { [field]: [identity], password: userPassword },
      { [field]: { value: identity }, password: userPassword }, { [field]: 42, password: userPassword },
      { [field]: identity, password: [userPassword] }, { [field]: identity, password: null },
      { [field]: identity, password: { value: userPassword } }];
    for (const body of bodies) {
      const response = await f.api(path, { method: "POST", body });
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error.code, "INVALID_LOGIN_REQUEST");
      assert.equal(response.headers.getSetCookie().length, 0);
    }
  });
}
