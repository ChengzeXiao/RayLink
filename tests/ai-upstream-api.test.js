import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRayLinkApp } from "../server/app.js";

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-ai-upstream-api-"));
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

test("AI upstream configuration is authenticated and starts disabled without residential credentials", async (t) => {
  const { request, origin } = await fixture(t);
  assert.equal((await fetch(origin + "/api/settings/ai-upstream")).status, 401);
  const response = await request("/api/settings/ai-upstream");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.config.enabled, false);
  assert.equal(result.config.hostId, "local");
  assert.equal(result.config.passwordConfigured, false);
  assert.ok(["pending", "current", "simulated"].includes(result.runtimeSync.status));
  assert.equal(Object.hasOwn(result.config, "password"), false);
});

test("saving an upstream publishes a simulated configuration, preserves its password and pins only the local Host", async (t) => {
  const { request } = await fixture(t);
  const secret = "private-upstream-password";
  const saved = await request("/api/settings/ai-upstream", "PATCH", {
    enabled: true, type: "http", server: "proxy.example.com", port: 8080, username: "proxy-user", password: secret
  });
  assert.equal(saved.status, 200);
  const state = await saved.json();
  assert.equal(state.config.passwordConfigured, true);
  assert.equal(state.runtimeSync.status, "simulated");
  const preserved = await (await request("/api/settings/ai-upstream", "PATCH", { port: 8081 })).json();
  assert.equal(preserved.config.passwordConfigured, true);
  assert.ok(preserved.config.revision > state.config.revision);
  const bootstrap = await (await request("/api/bootstrap")).json();
  assert.deepEqual(bootstrap.routingPolicy.aiExit, { mode: "pinned", hostId: "local" });
  assert.equal(bootstrap.routingPolicy.mode, "smart");
  assert.equal(bootstrap.aiUpstream.config.port, 8081);
  for (const path of ["/api/settings/ai-upstream", "/api/bootstrap", "/api/deployments", "/api/audit"]) {
    assert.doesNotMatch(await (await request(path)).text(), new RegExp(secret));
  }
  const conflict = await request("/api/settings/routing", "PATCH", { mode: "smart", rules: [], aiExit: { mode: "auto" } });
  assert.equal(conflict.status, 409);
  assert.equal((await request("/api/settings/ai-upstream/publish", "POST", {})).status, 200);
  const disabled = await (await request("/api/settings/ai-upstream", "PATCH", { enabled: false })).json();
  assert.equal(disabled.config.enabled, false);
  assert.equal(disabled.config.passwordConfigured, true);
});

test("failed Runtime publication is pending and does not leak a proxy password through errors", async (t) => {
  const secret = "private-publication-password";
  const { request } = await fixture(t, { runtimeAdapter: {
    status: async () => ({ mode: "systemd", state: "stopped" }),
    publish: async () => { throw new Error(`Native error contains ${secret}`); }
  } });
  const result = await (await request("/api/settings/ai-upstream", "PATCH", {
    enabled: true, type: "https", server: "proxy.example.com", port: 443, username: "proxy-user", password: secret
  })).json();
  assert.equal(result.runtimeSync.status, "pending");
  assert.equal(result.config.enabled, true);
  for (const path of ["/api/settings/ai-upstream", "/api/bootstrap", "/api/deployments", "/api/audit"]) {
    assert.doesNotMatch(await (await request(path)).text(), new RegExp(secret));
  }
});

test("AI diagnostic cache follows the chosen upstream revision and never reuses direct observations", async (t) => {
  let direct = 0, upstream = 0;
  const resolve = async () => [{ address: "1.1.1.1", family: 4 }];
  const { request } = await fixture(t, {
    aiDiagnosticProbe: { resolve, request: async () => { direct++; return { httpStatus: 403 }; } },
    aiUpstreamDiagnosticProbe: { resolve, request: async () => { upstream++; return { httpStatus: 401 }; } }
  });
  const before = await (await request("/api/routing/ai-check", "POST", { service: "claude" })).json();
  assert.equal(before.source, "control-plane-egress");
  const saved = await (await request("/api/settings/ai-upstream", "PATCH", { enabled: true, type: "http", server: "proxy.example.com", port: 8080 })).json();
  assert.equal((await (await request("/api/routing/ai-check")).json()).report, null);
  const after = await (await request("/api/routing/ai-check", "POST", { service: "claude" })).json();
  assert.equal(after.source, "control-plane-via-upstream");
  assert.equal(after.configRevision, saved.config.revision);
  assert.ok(after.results.every((row) => row.status === "authentication_required"));
  assert.equal(direct, 2); assert.equal(upstream, 2);
  await request("/api/routing/ai-check", "POST", { service: "claude" });
  assert.equal(upstream, 2);
  await request("/api/settings/ai-upstream", "PATCH", { enabled: false });
  assert.equal((await (await request("/api/routing/ai-check")).json()).report, null);
});

test("retry publication recovers a stopped Runtime even when the saved checksum did not change", async (t) => {
  let state = "stopped", publications = 0;
  const { request } = await fixture(t, { runtimeAdapter: {
    status: async () => ({ mode: "systemd", state }),
    publish: async () => { publications++; state = "running"; return { mode: "systemd", state }; }
  } });
  await request("/api/settings/ai-upstream", "PATCH", { enabled: true, type: "http", server: "proxy.example.com", port: 8080 });
  assert.equal(publications, 1);
  state = "stopped";
  const retried = await (await request("/api/settings/ai-upstream/publish", "POST", {})).json();
  assert.equal(publications, 2);
  assert.equal(retried.runtimeSync.status, "current");
});

test("a concurrent upstream update cannot label an old unpublished configuration current", async (t) => {
  let shouldFail = true, gateNext = false, started, release;
  const gated = new Promise((resolve) => { started = resolve; });
  const { request } = await fixture(t, { runtimeAdapter: {
    status: async () => {
      if (gateNext) { gateNext = false; started(); await new Promise((resolve) => { release = resolve; }); }
      return { mode: "systemd", state: "running" };
    },
    publish: async () => { if (shouldFail) throw new Error("fixture publication fails"); return { mode: "systemd", state: "running" }; }
  } });
  const first = await (await request("/api/settings/ai-upstream", "PATCH", { enabled: true, type: "http", server: "proxy.example.com", port: 8080 })).json();
  assert.equal(first.runtimeSync.status, "pending");
  gateNext = true;
  const oldRequest = request("/api/settings/ai-upstream");
  await gated;
  shouldFail = false;
  const applied = await (await request("/api/settings/ai-upstream", "PATCH", { port: 8081 })).json();
  assert.equal(applied.runtimeSync.status, "current");
  release();
  const result = await (await oldRequest).json();
  assert.equal(result.config.port, 8081);
  assert.equal(result.config.revision, applied.config.revision);
  assert.equal(result.runtimeSync.status, "current");
});
