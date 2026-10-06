import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRayLinkApp } from "../server/app.js";

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-ai-egress-api-"));
  const app = await createRayLinkApp({ dataDir, publicOrigin: "http://127.0.0.1", adminUsername: "admin",
    adminPassword: "test-administrator-password", runtimeMode: "dry-run", seedDemoData: false,
    singBoxBinary: join(dataDir, "missing-runtime"), backupIntervalMs: 0, alertIntervalMs: 0, runtimeUpdateCheckIntervalMs: 0,
    installer: { status: async () => ({ installed: false, version: null, tags: [] }) },
    ruleSetCache: { prepare: async () => {}, available: () => false, get: async () => null }, ...overrides });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(origin + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-administrator-password" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const request = (path, method = "GET", body) => fetch(origin + path, {
    method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { app, request, origin };
}

test("AI egress defaults to server, is authenticated and exposes a safe bootstrap view", async (t) => {
  const { request, origin } = await fixture(t);
  assert.equal((await fetch(origin + "/api/settings/ai-egress")).status, 401);
  const response = await request("/api/settings/ai-egress");
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.mode, "server");
  assert.equal(view.upstream.enabled, false);
  assert.equal(view.runtimeSync.publishedMode, null);
  assert.equal(Object.hasOwn(view.upstream, "password"), false);
  assert.deepEqual((await (await request("/api/bootstrap")).json()).aiEgress, view);
});

test("routing API saves manual AI selection and legacy writes or egress changes preserve it", async t => {
  const { request } = await fixture(t);
  const baseline = (await (await request("/api/bootstrap")).json()).routingPolicy;
  assert.equal(baseline.aiSelection, "fallback");
  const save = await request("/api/settings/routing", "PATCH", {
    ...baseline, aiSelection: "manual", aiExit: { mode: "pinned", hostId: "local" }
  });
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.aiSelection, "manual");
  assert.equal(saved.runtimeSync.status, "not-required");
  const legacy = await request("/api/settings/routing", "PATCH", { mode: "smart", rules: [] });
  assert.equal((await legacy.json()).aiSelection, "manual");
  assert.equal((await request("/api/settings/ai-egress", "PATCH", { mode: "server" })).status, 200);
  const read = (await (await request("/api/bootstrap")).json()).routingPolicy;
  assert.equal(read.aiSelection, "manual");
  assert.deepEqual(read.aiExit, { mode: "pinned", hostId: "local" });
  assert.equal((await request("/api/settings/routing", "PATCH", { ...read, aiSelection: "random" })).status, 422);
  assert.equal((await (await request("/api/bootstrap")).json()).routingPolicy.aiSelection, "manual");
});

test("AI egress switches exclusively, preserves credentials and stays compatible with legacy settings", async (t) => {
  const { request } = await fixture(t);
  const secret = "private-unified-egress-password";
  const residential = await (await request("/api/settings/ai-egress", "PATCH", {
    mode: "residential", upstream: { type: "https", server: "proxy.example.com", port: 443, username: "proxy-user", password: secret }
  })).json();
  assert.equal(residential.mode, "residential");
  assert.equal(residential.runtimeSync.status, "simulated");
  assert.equal(residential.runtimeSync.publishedMode, "residential");
  assert.deepEqual(residential.aiExit, { mode: "pinned", hostId: "local" });
  assert.equal(residential.upstream.passwordConfigured, true);
  const conflict = await request("/api/settings/ai-egress", "PATCH", { mode: "server", aiExit: { mode: "pinned", hostId: "missing" } });
  assert.equal(conflict.status, 422);
  assert.equal((await (await request("/api/settings/ai-egress")).json()).mode, "residential");
  const server = await (await request("/api/settings/ai-egress", "PATCH", { mode: "server", aiExit: { mode: "auto" } })).json();
  assert.equal(server.mode, "server");
  assert.equal(server.upstream.enabled, false);
  assert.equal(server.upstream.passwordConfigured, true);
  assert.equal(server.aiExit.mode, "auto");
  assert.equal(server.runtimeSync.publishedMode, "server");
  assert.equal((await (await request("/api/settings/ai-upstream")).json()).config.enabled, false);
  await request("/api/settings/ai-upstream", "PATCH", { enabled: true });
  assert.equal((await (await request("/api/settings/ai-egress")).json()).mode, "residential");
  for (const path of ["/api/settings/ai-egress", "/api/bootstrap", "/api/deployments", "/api/audit"]) {
    assert.ok(!(await (await request(path)).text()).includes(secret), path);
  }
  assert.equal((await request("/api/settings/ai-egress", "PATCH", { mode: "server", upstream: {} })).status, 422);
  assert.equal((await request("/api/settings/ai-egress/publish", "POST", { mode: "server" })).status, 422);
});

test("failed server switch reports saved mode separately from last publication and retry applies it", async (t) => {
  let fail = false;
  const { request } = await fixture(t, { runtimeAdapter: {
    status: async () => ({ mode: "systemd", state: "running" }),
    publish: async () => { if (fail) throw new Error("private-publication-detail"); return { mode: "systemd", state: "running" }; }
  } });
  const first = await (await request("/api/settings/ai-egress", "PATCH", {
    mode: "residential", upstream: { type: "socks5", server: "proxy.example.com", port: 1080 }
  })).json();
  assert.equal(first.runtimeSync.status, "current");
  assert.equal(first.runtimeSync.publishedMode, "residential");
  fail = true;
  const failed = await (await request("/api/settings/ai-egress", "PATCH", { mode: "server" })).json();
  assert.equal(failed.mode, "server");
  assert.equal(failed.runtimeSync.status, "pending");
  assert.equal(failed.runtimeSync.publishedMode, "residential");
  assert.doesNotMatch(JSON.stringify(failed), /private-publication-detail/);
  const read = await (await request("/api/settings/ai-egress")).json();
  assert.equal(read.runtimeSync.publishedMode, "residential");
  assert.equal(read.runtimeSync.status, "pending");
  fail = false;
  const retried = await (await request("/api/settings/ai-egress/publish", "POST", {})).json();
  assert.equal(retried.runtimeSync.status, "current");
  assert.equal(retried.runtimeSync.publishedMode, "server");
});

test("AI egress requires runtime management for either mutation", async (t) => {
  const { request, origin } = await fixture(t);
  const password = "support-test-password";
  assert.equal((await request("/api/admins", "POST", { username: "support-user", password, role: "support" })).status, 201);
  const login = await fetch(origin + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "support-user", password }) });
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  assert.equal((await fetch(origin + "/api/settings/ai-egress", { headers: { cookie } })).status, 200);
  for (const [path, method, body] of [["/api/settings/ai-egress", "PATCH", { mode: "server" }], ["/api/settings/ai-egress/publish", "POST", {}]]) {
    assert.equal((await fetch(origin + path, { method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) })).status, 403);
  }
});

test("failed dry-run switches retain explicit simulated Runtime evidence", async (t) => {
  let fail = false;
  const { request } = await fixture(t, { runtimeAdapter: {
    status: async () => ({ mode: "dry-run", state: "staged" }),
    publish: async () => { if (fail) throw new Error("simulated failure"); return { mode: "dry-run", state: "staged" }; }
  } });
  await request("/api/settings/ai-egress", "PATCH", { mode: "server" });
  fail = true;
  const result = await (await request("/api/settings/ai-egress", "PATCH", {
    mode: "residential", upstream: { type: "http", server: "proxy.example.com", port: 8080 }
  })).json();
  assert.equal(result.runtimeSync.status, "pending");
  assert.equal(result.runtimeSync.publishedMode, "server");
  assert.equal(result.runtimeSync.runtimeMode, "dry-run");
});
