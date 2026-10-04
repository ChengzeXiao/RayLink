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
