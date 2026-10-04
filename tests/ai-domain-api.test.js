import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRayLinkApp } from "../server/app.js";

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-ai-egress-api-"));
  const options = { dataDir, publicOrigin: "http://127.0.0.1", adminUsername: "admin",
    adminPassword: "test-administrator-password", runtimeMode: "dry-run", seedDemoData: false,
    singBoxBinary: join(dataDir, "missing-runtime"), backupIntervalMs: 0, alertIntervalMs: 0, runtimeUpdateCheckIntervalMs: 0,
    installer: { status: async () => ({ installed: false, version: null, tags: [] }) },
    ruleSetCache: { prepare: async () => {}, available: () => false, get: async () => null }, ...overrides };
  let app, origin, cookie;
  async function start() {
    app = await createRayLinkApp(options);
    await app.listen({ host: "127.0.0.1", port: 0 });
    origin = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(origin + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "test-administrator-password" }) });
    assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie()[0].split(";")[0];
  }
  await start();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = (path, method = "GET", body) => fetch(origin + path, {
    method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { get app() { return app; }, request, get origin() { return origin; },
    async restart(nextOptions) { await app.close(); Object.assign(options, nextOptions); await start(); } };
}

test("lost upstream encryption key keeps saved rules and all configuration reads pending until credentials recover", async t => {
  const oldPassword = "private-old-upstream-password", nextPassword = "private-new-upstream-password";
  const oldKey = "private-old-encryption-key", nextKey = "private-new-encryption-key";
  let failPublication = false;
  const state = await fixture(t, { subscriptionEncryptionKey: oldKey, runtimeAdapter: {
    status: async () => ({ mode: "systemd", state: "running" }),
    publish: async () => { if (failPublication) throw new Error(nextPassword); return { mode: "systemd", state: "running" }; }
  } });
  const { request } = state;
  const initial = await request("/api/settings/ai-egress", "PATCH", { mode: "residential", upstream: {
    type: "http", server: "proxy.example", port: 8080, username: "fixture-user", password: oldPassword
  } });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).runtimeSync.status, "current");
  await state.restart({ subscriptionEncryptionKey: nextKey });
  const rules = [{ id: "new-ai", match: "domain", value: "assistant.example", action: "ai" }];
  const savedResponse = await request("/api/settings/routing", "PATCH", { mode: "smart", rules });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.rules[0].id, "new-ai");
  const payloads = [saved];
  for (const [path, method, body] of [
    ["/api/settings/ai-egress"], ["/api/settings/ai-upstream"], ["/api/bootstrap"],
    ["/api/routing/diagnose", "POST", { domain: "assistant.example" }],
    ["/api/settings/ai-egress/publish", "POST", {}]
  ]) {
    const response = await request(path, method, body);
    assert.equal(response.status, 200, path);
    const payload = await response.json(); payloads.push(payload);
    const sync = payload.runtimeSync || payload.aiDomain?.runtimeSync || payload.aiEgress?.runtimeSync;
    assert.equal(sync.status, "pending", path);
    assert.equal(sync.errorCode, "AI_UPSTREAM_SECRET_UNAVAILABLE", path);
    assert.match(sync.message, /凭据|加密密钥/, path);
    assert.equal(sync.runtimeMode, "systemd");
    assert.equal(sync.publishedMode, "residential");
    if (path === "/api/bootstrap") {
      assert.equal(payload.runtimePreview, null);
      assert.equal(payload.routingPolicy.rules[0].id, "new-ai");
    }
  }
  failPublication = true;
  const recovery = await request("/api/settings/ai-egress", "PATCH", { mode: "residential", upstream: { password: nextPassword } });
  assert.equal(recovery.status, 200);
  const recovered = await recovery.json(); payloads.push(recovered);
  assert.equal(recovered.runtimeSync.status, "pending");
  failPublication = false;
  const retry = await (await request("/api/settings/ai-egress/publish", "POST", {})).json();
  assert.equal(retry.runtimeSync.status, "current");
  const bootstrap = await (await request("/api/bootstrap")).json();
  assert.equal(bootstrap.aiEgress.runtimeSync.status, "current");
  assert.equal(bootstrap.routingPolicy.rules[0].id, "new-ai");
  assert.ok(bootstrap.runtimePreview.checksum);
  payloads.push(retry, bootstrap);
  for (const value of [oldPassword, nextPassword, oldKey, nextKey]) assert.ok(!JSON.stringify(payloads).includes(value));
});

test("configuration reads preserve Runtime status failures instead of reporting publication pending", async t => {
  let failStatus = false;
  const secret = "private-runtime-status-error";
  const { request } = await fixture(t, { runtimeAdapter: {
    status: async () => {
      if (failStatus) throw new Error(secret);
      return { mode: "systemd", state: "running" };
    },
    publish: async () => ({ mode: "systemd", state: "running" })
  } });
  failStatus = true;
  for (const path of ["/api/settings/ai-egress", "/api/settings/ai-upstream", "/api/bootstrap"]) {
    const response = await request(path);
    assert.equal(response.status, 500, path);
    const payload = await response.json();
    assert.equal(payload.error.code, "INTERNAL_ERROR", path);
    assert.equal(payload.runtimeSync, undefined, path);
    assert.ok(!JSON.stringify(payload).includes(secret), path);
  }
});

test("routing updates publish residential domain changes and explain the selected rule", async t => {
  const { request } = await fixture(t);
  await request("/api/settings/ai-egress", "PATCH", { mode: "residential", upstream: { type: "http", server: "proxy.example", port: 8080 } });
  const response = await request("/api/settings/routing", "PATCH", { mode: "smart", rules: [
    { id: "custom-ai", match: "domain_suffix", value: "assistant.example", action: "ai" }
  ] });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.runtimeSync?.status, "simulated");
  const diagnosis = await (await request("/api/routing/diagnose", "POST", { domain: "api.assistant.example" })).json();
  assert.equal(diagnosis.action, "ai");
  assert.equal(diagnosis.aiDomain.eligible, true);
  assert.equal(diagnosis.aiDomain.source, "custom");
  assert.equal(diagnosis.aiDomain.ruleId, "custom-ai");
  assert.equal(diagnosis.aiDomain.desiredEgress, "residential");
  assert.equal(diagnosis.aiDomain.runtimeSync.status, "simulated");
  assert.equal(diagnosis.evidence.clientMeasured, false);
  const bootstrap = await (await request("/api/bootstrap")).json();
  assert.ok(bootstrap.aiDomainRules.version);
  assert.ok(bootstrap.aiDomainRules.domainSuffixes.includes("claude.ai"));
  assert.equal(bootstrap.aiDomainRules.customRules[0].id, "custom-ai");
});

test("ordinary shared domains remain outside residential even with a broad AI rule", async t => {
  const { request } = await fixture(t);
  await request("/api/settings/ai-egress", "PATCH", { mode: "residential", upstream: { type: "http", server: "proxy.example", port: 8080 } });
  await request("/api/settings/routing", "PATCH", { mode: "smart", rules: [
    { id: "broad", match: "domain_suffix", value: "google.com", action: "ai" }
  ] });
  const diagnose = async domain => (await request("/api/routing/diagnose", "POST", { domain })).json();
  const ordinary = await diagnose("www.google.com");
  assert.equal(ordinary.aiDomain.eligible, false);
  assert.equal(ordinary.aiDomain.source, "shared");
  assert.equal(ordinary.aiDomain.desiredEgress, "server");
  const dedicated = await diagnose("gemini.google.com");
  assert.equal(dedicated.aiDomain.eligible, true);
  assert.equal(dedicated.aiDomain.desiredEgress, "residential");
});

test("domain publication failure stays pending, hides credentials and retries the saved rules", async t => {
  let fail = false, publications = 0;
  const secret = "private-domain-publication-secret";
  const { request } = await fixture(t, { runtimeAdapter: {
    status: async () => ({ mode: "systemd", state: "running" }),
    publish: async () => { publications++; if (fail) throw new Error(secret); return { mode: "systemd", state: "running" }; }
  } });
  await request("/api/settings/ai-egress", "PATCH", { mode: "residential", upstream: { type: "http", server: "proxy.example", port: 8080, username: "fixture-user", password: secret } });
  fail = true;
  const rules = [{ match: "domain", value: "assistant.example", action: "ai" }];
  const saved = await (await request("/api/settings/routing", "PATCH", { mode: "smart", rules })).json();
  assert.equal(saved.runtimeSync.status, "pending");
  assert.equal(saved.rules[0].value, "assistant.example");
  assert.equal(publications, 2);
  const diagnostic = await (await request("/api/routing/diagnose", "POST", { domain: "assistant.example" })).json();
  assert.equal(diagnostic.aiDomain.runtimeSync.status, "pending");
  assert.ok(!JSON.stringify({ saved, diagnostic }).includes(secret));
  fail = false;
  const retry = await (await request("/api/settings/ai-egress/publish", "POST", {})).json();
  assert.equal(retry.runtimeSync.status, "current");
  assert.equal(publications, 3);
  await request("/api/settings/routing", "PATCH", { mode: "smart", rules });
  assert.equal(publications, 3, "identical rule writes do not restart an already current Runtime");
});

test("default egress edits need no Runtime publication and preserve the saved AI host", async t => {
  let publications = 0;
  const { request } = await fixture(t, { runtimeAdapter: {
    status: async () => ({ mode: "systemd", state: "running" }),
    publish: async () => { publications++; return { mode: "systemd", state: "running" }; }
  } });
  await request("/api/settings/ai-egress", "PATCH", { mode: "server", aiExit: { mode: "pinned", hostId: "local" } });
  const before = publications;
  const saved = await (await request("/api/settings/routing", "PATCH", { mode: "smart", rules: [
    { match: "domain", value: "assistant.example", action: "ai" }
  ] })).json();
  assert.equal(saved.runtimeSync.status, "not-required");
  assert.deepEqual(saved.aiExit, { mode: "pinned", hostId: "local" });
  assert.equal(publications, before);
});

test("diagnosis does not label blocked or client-direct traffic as server egress", async t => {
  const { request } = await fixture(t);
  for (const [action, expected] of [["block", "blocked"], ["direct", "client-direct"]]) {
    await request("/api/settings/routing", "PATCH", { mode: "smart", rules: [
      { match: "domain", value: "claude.ai", action }
    ] });
    const result = await (await request("/api/routing/diagnose", "POST", { domain: "claude.ai" })).json();
    assert.equal(result.action, action);
    assert.equal(result.aiDomain.desiredEgress, expected);
  }
});
