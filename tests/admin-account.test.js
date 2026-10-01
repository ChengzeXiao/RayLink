import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRayLinkApp } from "../server/app.js";

const initialPassword = "account-initial-" + "password";
const changedPassword = "account-changed-" + "password";
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-account-"));
  const app = await createRayLinkApp({
    dataDir, adminUsername: "admin", adminPassword: initialPassword,
    publicOrigin: "http://127.0.0.1", runtimeMode: "dry-run", seedDemoData: false,
    singBoxBinary: join(dataDir, "missing"), backupIntervalMs: 0, alertIntervalMs: 0,
    runtimeUpdateCheckIntervalMs: 0, entitlementReconcileIntervalMs: 0, protocolLatencyIntervalMs: 0,
    installer: { async status() { return { installed: false, tags: [] }; } },
    ruleSetCache: { prepare: async () => {}, available: () => false, get: async () => null }
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = (cookie, path, method = "GET", body) => fetch(`${base}${path}`, {
    method, headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const login = async (username = "admin", password = initialPassword) => {
    const response = await api("", "/api/auth/login", "POST", { username, password });
    return { response, cookie: response.headers.getSetCookie()[0]?.split(";")[0] || "" };
  };
  const mcpStatus = async (token) => {
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream"
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    await response.text();
    return response.status;
  };
  return { base, api, login, mcpStatus, cookie: (await login()).cookie };
}

test("self password change requires the old password and revokes all browser and MCP credentials", async (t) => {
  const f = await fixture(t);
  const second = (await f.login()).cookie;
  const token = await (await f.api(f.cookie, "/api/mcp/tokens", "POST", { name: "Account check", scopes: ["read"] })).json();
  assert.equal(await f.mcpStatus(token.token), 200);
  const invalid = await f.api(f.cookie, "/api/account/password", "POST", { currentPassword: "incorrect", newPassword: changedPassword });
  assert.equal(invalid.status, 403);
  assert.equal((await invalid.json()).error.code, "CURRENT_PASSWORD_INVALID");
  assert.equal((await f.api(second, "/api/bootstrap")).status, 200);
  const changed = await f.api(f.cookie, "/api/account/password", "POST", { currentPassword: initialPassword, newPassword: changedPassword });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { passwordChanged: true, reauthenticationRequired: true, sessionsRevoked: 2, mcpTokensRevoked: 1 });
  assert.match(changed.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await f.api(f.cookie, "/api/bootstrap")).status, 401);
  assert.equal((await f.api(second, "/api/bootstrap")).status, 401);
  assert.equal(await f.mcpStatus(token.token), 401);
  assert.equal((await f.login()).response.status, 401);
  assert.equal((await f.login("admin", changedPassword)).response.status, 200);
});

test("self username change checks uniqueness and password, revokes browser sessions and retains MCP access", async (t) => {
  const f = await fixture(t);
  await f.api(f.cookie, "/api/admins", "POST", { username: "taken", password: initialPassword, role: "auditor" });
  const token = await (await f.api(f.cookie, "/api/mcp/tokens", "POST", { name: "Rename check", scopes: ["read"] })).json();
  const invalid = await f.api(f.cookie, "/api/account/profile", "PATCH", { currentPassword: "wrong", username: "renamed" });
  assert.equal(invalid.status, 403);
  assert.equal((await invalid.json()).error.code, "CURRENT_PASSWORD_INVALID");
  const duplicate = await f.api(f.cookie, "/api/account/profile", "PATCH", { currentPassword: initialPassword, username: "taken" });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "ADMIN_USERNAME_EXISTS");
  assert.equal((await f.api(f.cookie, "/api/bootstrap")).status, 200);
  const changed = await f.api(f.cookie, "/api/account/profile", "PATCH", { currentPassword: initialPassword, username: "renamed", role: "auditor" });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { profileUpdated: true, username: "renamed", reauthenticationRequired: true, sessionsRevoked: 1, mcpTokensRevoked: 0 });
  assert.match(changed.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await f.api(f.cookie, "/api/bootstrap")).status, 401);
  assert.equal((await f.login()).response.status, 401);
  const relogin = await f.login("renamed");
  assert.equal(relogin.response.status, 200);
  assert.equal((await f.api(relogin.cookie, "/api/admins")).status, 200);
  assert.equal(await f.mcpStatus(token.token), 200);
});

test("Owner renames another admin with session revocation, and password reset also revokes MCP credentials", async (t) => {
  const f = await fixture(t);
  const target = await (await f.api(f.cookie, "/api/admins", "POST", { username: "target", password: initialPassword, role: "owner" })).json();
  const targetLogin = await f.login("target");
  const token = await (await f.api(targetLogin.cookie, "/api/mcp/tokens", "POST", { name: "Reset check", scopes: ["read"] })).json();
  assert.equal((await f.api(f.cookie, `/api/admins/${target.id}`, "PATCH", { username: "target-new" })).status, 200);
  assert.equal((await f.api(targetLogin.cookie, "/api/bootstrap")).status, 401);
  assert.equal(await f.mcpStatus(token.token), 200);
  const renamedLogin = await f.login("target-new");
  assert.equal(renamedLogin.response.status, 200);
  assert.equal((await f.api(f.cookie, `/api/admins/${target.id}`, "PATCH", { password: changedPassword })).status, 200);
  assert.equal((await f.api(renamedLogin.cookie, "/api/bootstrap")).status, 401);
  assert.equal(await f.mcpStatus(token.token), 401);
  assert.equal((await f.login("target-new", changedPassword)).response.status, 200);
});

test("password policy rejects blank, oversized and unchanged passwords without revoking access", async (t) => {
  const f = await fixture(t);
  for (const newPassword of ["short", " ".repeat(12), "x".repeat(1025)]) {
    const response = await f.api(f.cookie, "/api/account/password", "POST", { currentPassword: initialPassword, newPassword });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "INVALID_ADMIN_PASSWORD");
  }
  const unchanged = await f.api(f.cookie, "/api/account/password", "POST", { currentPassword: initialPassword, newPassword: initialPassword });
  assert.equal(unchanged.status, 422);
  assert.equal((await unchanged.json()).error.code, "PASSWORD_UNCHANGED");
  assert.equal((await f.api(f.cookie, "/api/bootstrap")).status, 200);
});

test("Owner cannot bypass old password verification through the administrative reset route, including MCP", async (t) => {
  const f = await fixture(t);
  const owner = (await (await f.api(f.cookie, "/api/admins")).json()).admins.find((admin) => admin.username === "admin");
  for (const input of [{ password: changedPassword }, { username: "bypassed" }]) {
    const response = await f.api(f.cookie, `/api/admins/${owner.id}`, "PATCH", input);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "ACCOUNT_SELF_SERVICE_REQUIRED");
  }
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const token = await (await f.api(f.cookie, "/api/mcp/tokens", "POST", { name: "Owner integration", scopes: ["admins.manage"] })).json();
  const client = new Client({ name: "account-check", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } }));
  try {
    const result = await client.callTool({ name: "admins_update", arguments: { adminId: owner.id, password: changedPassword, requestId: "self-password-bypass" } });
    assert.equal(result.isError, true);
    const output = result.structuredContent || JSON.parse(result.content[0].text);
    assert.equal(output.error.code, "ACCOUNT_SELF_SERVICE_REQUIRED");
  } finally { await client.close(); }
  assert.equal((await f.api(f.cookie, "/api/bootstrap")).status, 200);
});

test("password rotation does not let in-flight logins recreate sessions from the old password", async (t) => {
  const f = await fixture(t);
  const rotation = f.api(f.cookie, "/api/account/password", "POST", { currentPassword: initialPassword, newPassword: changedPassword });
  const attempts = Array.from({ length: 6 }, () => f.login());
  assert.equal((await rotation).status, 200);
  for (const login of await Promise.all(attempts)) {
    if (login.cookie) assert.equal((await f.api(login.cookie, "/api/bootstrap")).status, 401);
  }
});

test("operator, support and auditor can change their own identity without gaining administrator management", async (t) => {
  const f = await fixture(t);
  for (const role of ["operator", "support", "auditor"]) {
    const created = await f.api(f.cookie, "/api/admins", "POST", { username: role, password: initialPassword, role });
    assert.equal(created.status, 201);
    const login = await f.login(role);
    assert.equal((await f.api(login.cookie, "/api/admins")).status, 403);
    const profile = await f.api(login.cookie, "/api/account/profile", "PATCH", { currentPassword: initialPassword, username: `${role}-new`, role: "owner" });
    assert.equal(profile.status, 200);
    const renamed = await f.login(`${role}-new`);
    assert.equal((await f.api(renamed.cookie, "/api/admins")).status, 403);
    const password = await f.api(renamed.cookie, "/api/account/password", "POST", { currentPassword: initialPassword, newPassword: changedPassword });
    assert.equal(password.status, 200);
    assert.equal((await f.login(`${role}-new`, changedPassword)).response.status, 200);
  }
});

test("simultaneous self password changes cannot both use the same old password", async (t) => {
  const f = await fixture(t);
  const passwords = [changedPassword, "another-account-password"];
  const responses = await Promise.all(passwords.map((newPassword) => f.api(f.cookie, "/api/account/password", "POST", { currentPassword: initialPassword, newPassword })));
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  const failed = responses.find((response) => response.status !== 200);
  assert.ok([401, 403, 409].includes(failed.status));
  const winner = passwords[responses.findIndex((response) => response.status === 200)];
  assert.equal((await f.login("admin", winner)).response.status, 200);
});

test("wrong current passwords are rate limited and failure never revokes a valid session", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 8; index += 1) {
    const response = await f.api(f.cookie, "/api/account/password", "POST", { currentPassword: "incorrect", newPassword: changedPassword });
    assert.equal(response.status, 403);
  }
  const blocked = await f.api(f.cookie, "/api/account/profile", "PATCH", { currentPassword: initialPassword, username: "renamed" });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, "RATE_LIMITED");
  assert.equal((await f.api(f.cookie, "/api/bootstrap")).status, 200);
});

test("duplicate usernames and last Owner failures roll back password resets and credential revocations", async (t) => {
  const f = await fixture(t);
  const other = await (await f.api(f.cookie, "/api/admins", "POST", { username: "other", password: initialPassword, role: "owner" })).json();
  const owner = (await (await f.api(f.cookie, "/api/admins")).json()).admins.find((admin) => admin.username === "admin");
  const otherLogin = await f.login("other");
  const token = await (await f.api(otherLogin.cookie, "/api/mcp/tokens", "POST", { name: "Rollback check", scopes: ["read"] })).json();
  const duplicate = await f.api(f.cookie, `/api/admins/${other.id}`, "PATCH", { username: "admin", password: changedPassword });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "ADMIN_USERNAME_EXISTS");
  assert.equal((await f.api(otherLogin.cookie, "/api/bootstrap")).status, 200);
  assert.equal(await f.mcpStatus(token.token), 200);
  assert.equal((await f.api(otherLogin.cookie, `/api/admins/${owner.id}`, "PATCH", { role: "auditor" })).status, 200);
  const lastOwner = await f.api(otherLogin.cookie, `/api/admins/${other.id}`, "PATCH", { role: "auditor" });
  assert.equal(lastOwner.status, 409);
  assert.equal((await lastOwner.json()).error.code, "LAST_OWNER_REQUIRED");
  assert.equal((await f.login("other")).response.status, 200);
});

test("empty account payloads return validation errors without changing the session", async (t) => {
  const f = await fixture(t);
  for (const [path, method, code] of [
    ["/api/account/password", "POST", "INVALID_ADMIN_PASSWORD"],
    ["/api/account/profile", "PATCH", "INVALID_ADMIN_USERNAME"]
  ]) {
    const response = await f.api(f.cookie, path, method, null);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal((await f.api(f.cookie, "/api/bootstrap")).status, 200);
});
