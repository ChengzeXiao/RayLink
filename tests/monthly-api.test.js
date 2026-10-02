import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createRayLinkApp } from "../server/app.js";

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-monthly-api-"));
  let now = new Date("2026-10-31T15:59:59.000Z");
  const app = await createRayLinkApp({
    dataDir, publicOrigin: "http://127.0.0.1", adminUsername: "admin",
    adminPassword: "Monthly-test-pass-123!", seedDemoData: false,
    runtimeMode: "dry-run", singBoxBinary: join(dataDir, "no-binary"),
    clock: () => now, backupIntervalMs: 0, alertIntervalMs: 0,
    runtimeUpdateCheckIntervalMs: 0, protocolLatencyIntervalMs: 0,
    ruleSetCache: { prepare: async () => {}, available: () => false, get: async () => null },
    installer: { status: async () => ({ installed: true, version: "1.14.2", tags: [] }) }
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "Monthly-test-pass-123!" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const api = async (path, method = "GET", body) => {
    const response = await fetch(base + path, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { app, base, api, advance: (value) => { now = new Date(value); } };
}

test("HTTP starts a new Shanghai month and restores an eligible user's published entitlement", async (t) => {
  const f = await fixture(t);
  f.app.store.updateHostProtocolConfig("local", "shadowsocks", {
    enabled: true, listen: "::", port: 8388, tls: { mode: "none" },
    transport: { type: "none" }, options: {}
  });
  const created = await f.api("/api/users", "POST", { name: "Monthly User", email: "monthly@example.test", quotaGb: 1, usedGb: 2, nodeScope: ["all"], expiresAt: "2099-12-31", portalStatus: "active", password: "Monthly-portal-pass!" });
  assert.equal(created.status, 201);
  assert.equal(created.body.usagePeriod?.key, "2026-10");
  assert.equal(created.body.usagePeriod.resetsAt, "2026-10-31T16:00:00.000Z");
  assert.equal((await f.api("/api/deployments", "POST", {})).status, 201);
  const before = await f.api("/api/bootstrap");
  assert.equal(before.body.runtimePreview.eligibleUsers, 0);
  f.advance("2026-10-31T16:00:00.000Z");
  const after = await f.api("/api/bootstrap");
  const user = after.body.users.find((item) => item.id === created.body.id);
  assert.equal(user.usedGb, 0);
  assert.equal(user.usagePeriod.key, "2026-11");
  assert.equal(user.quotaGb, 1);
  assert.equal(after.body.runtimePreview.eligibleUsers, 1);
  assert.equal(after.body.deployments.find((item) => item.status === "active").eligibleUsers, 1);
  const history = await f.api(`/api/users/${user.id}/usage-history`);
  assert.equal(history.status, 200);
  assert.equal(history.body.periods.find((period) => period.key === "2026-10").usedGb, 2);
  const stale = await f.api(`/api/users/${user.id}`, "PATCH", { usedGb: 5, usagePeriodKey: "2026-10" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "USAGE_PERIOD_CHANGED");
  assert.equal((await f.api("/api/bootstrap")).body.users[0].usedGb, 0);
});

test("read-only MCP and the user portal expose scoped monthly history without credentials", async (t) => {
  const f = await fixture(t);
  const first = await f.api("/api/users", "POST", { name: "First", email: "first@example.test", quotaGb: 10, usedGb: 1, nodeScope: ["all"], expiresAt: "2099-12-31", portalStatus: "active", password: "Monthly-portal-pass!" });
  const second = await f.api("/api/users", "POST", { name: "Second", email: "second@example.test", quotaGb: 10, usedGb: 3, nodeScope: ["all"], expiresAt: "2099-12-31" });
  f.advance("2026-10-31T16:00:00.000Z");
  assert.equal((await fetch(`${f.base}/api/users/${first.body.id}/usage-history`)).status, 401);
  const portalLogin = await fetch(`${f.base}/api/portal/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "first@example.test", password: "Monthly-portal-pass!" }) });
  assert.equal(portalLogin.status, 200);
  const portalCookie = portalLogin.headers.getSetCookie()[0].split(";")[0];
  assert.equal((await fetch(`${f.base}/api/portal/usage-history`)).status, 401);
  assert.equal((await fetch(`${f.base}/api/users/${second.body.id}/usage-history`, { headers: { cookie: portalCookie } })).status, 401);
  const ownHistory = await (await fetch(`${f.base}/api/portal/usage-history?userId=${second.body.id}`, { headers: { cookie: portalCookie } })).json();
  assert.equal(ownHistory.periods.find((period) => period.key === "2026-10").usedGb, 1);
  assert.equal((await f.api(`/api/users/${first.body.id}/usage-history?limit=0`)).status, 422);
  const issued = await f.api("/api/mcp/tokens", "POST", { name: "Read month usage", scopes: ["read"], expiresInDays: 1 });
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const client = new Client({ name: "monthly-test", version: "1" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${issued.body.token}` } } }));
  const history = await client.callTool({ name: "users_usage_history", arguments: { userId: first.body.id, limit: 12 } });
  assert.ok(!history.isError);
  const output = history.structuredContent || JSON.parse(history.content[0].text);
  assert.equal(output.periods.find((period) => period.key === "2026-10").usedGb, 1);
  assert.doesNotMatch(JSON.stringify(output), /runtimeUuid|runtimePassword|subscription|password|secret/i);
  const userResult = await client.callTool({ name: "users_get", arguments: { userId: first.body.id } });
  const user = userResult.structuredContent || JSON.parse(userResult.content[0].text);
  assert.equal(user.usagePeriod.key, "2026-11");
  assert.equal(user.usagePeriod.timeZone, "Asia/Shanghai");
  const missing = await client.callTool({ name: "users_usage_history", arguments: { userId: "missing-user" } });
  assert.equal(missing.isError, true);
  await assert.rejects(client.callTool({ name: "users_update", arguments: { userId: first.body.id, usedGb: 9 } }), /not found|permission|scope/i);
  assert.equal(f.app.store.getUser(first.body.id).usedGb, 0);
});

test("the month boundary timer resets usage without an incoming request", async (t) => {
  const f = await fixture(t);
  const user = f.app.store.createUser({ name: "Timer User", email: "timer@example.test", quotaGb: 10,
    usedGb: 4, nodeScope: ["all"], expiresAt: "2099-12-31" });
  f.advance("2026-10-31T16:00:00.000Z");
  const deadline = Date.now() + 4_000;
  while (f.app.store.usagePeriodStatus().key !== "2026-11" && Date.now() < deadline) await delay(25);
  assert.equal(f.app.store.usagePeriodStatus().key, "2026-11");
  assert.equal(f.app.store.getUser(user.id).usedGb, 0);
  assert.equal(f.app.store.userUsageHistory(user.id).find(period => period.key === "2026-10").usedGb, 4);
});
