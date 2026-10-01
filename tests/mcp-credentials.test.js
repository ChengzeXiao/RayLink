import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";
import { McpCredentials, MCP_SCOPES } from "../server/mcp-credentials.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-mcp-credentials-"));
  const options = {
    dbPath: join(directory, "store.db"), adminUsername: "admin",
    adminPassword: "test-password", seedDemoData: false
  };
  let store = new RayLinkStore(options);
  let now = new Date("2026-10-01T00:00:00.000Z");
  let credentials = new McpCredentials({ store, clock: () => now });
  const owner = store.listAdmins()[0];
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    owner, options,
    get store() { return store; },
    get credentials() { return credentials; },
    setTime(value) { now = new Date(value); },
    reopen() {
      store.close();
      store = new RayLinkStore(options);
      credentials = new McpCredentials({ store, clock: () => now });
    }
  };
}

test("MCP credentials persist authentication while exposing a plaintext token only at creation", async (t) => {
  const f = await fixture(t);
  const created = f.credentials.create({ adminId: f.owner.id, name: "  Operations bot  ", scopes: ["read", "audit.read"] });
  assert.match(created.token, /^rl_mcp_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.name, "Operations bot");
  assert.equal(created.expiresAt, "2026-10-31T00:00:00.000Z");
  const listed = f.credentials.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
  assert.doesNotMatch(JSON.stringify(listed), /token|hash|secret/i);
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(created.token));
  f.reopen();
  const authenticated = f.credentials.authenticate(created.token);
  assert.deepEqual(authenticated, {
    id: created.id, adminId: f.owner.id, scopes: ["read", "audit.read"],
    admin: { id: f.owner.id, username: "admin", role: "owner" }
  });
  assert.equal(f.credentials.list()[0].lastUsedAt, "2026-10-01T00:00:00.000Z");
  f.reopen();
  assert.equal((await readFile(f.options.dbPath)).includes(Buffer.from(created.token)), false);
});

test("MCP credential creation validates names, explicit scopes and bounded expiry before writing", async (t) => {
  const f = await fixture(t);
  const valid = { adminId: f.owner.id, name: "Bot", scopes: ["read"] };
  for (const name of [undefined, null, 42, "", "  ", "a".repeat(81), "bot\nadmin", "\tbot", "bot\u0000"]) {
    assert.throws(() => f.credentials.create({ ...valid, name }), { code: "INVALID_MCP_NAME", statusCode: 422 });
  }
  for (const scopes of [undefined, null, [], "read", ["*"], ["read", "unknown"], [1], [{}]]) {
    assert.throws(() => f.credentials.create({ ...valid, scopes }), { code: "INVALID_MCP_SCOPES", statusCode: 422 });
  }
  for (const expiresInDays of [null, "30", 0, -1, 366, 1.5, Infinity, NaN]) {
    assert.throws(() => f.credentials.create({ ...valid, expiresInDays }), { code: "INVALID_MCP_EXPIRY", statusCode: 422 });
  }
  assert.throws(() => f.credentials.create({ ...valid, adminId: "missing-admin" }), { code: "ADMIN_NOT_FOUND", statusCode: 404 });
  assert.equal(f.credentials.list().length, 0);
  const created = f.credentials.create({ ...valid, scopes: [...MCP_SCOPES.map(({ id }) => id), "read"], expiresInDays: 365 });
  assert.deepEqual(created.scopes, MCP_SCOPES.map(({ id }) => id));
  assert.equal(created.expiresAt, "2027-10-01T00:00:00.000Z");
});

test("MCP credentials reject unknown, expired and revoked tokens across reopening", async (t) => {
  const f = await fixture(t);
  const created = f.credentials.create({ adminId: f.owner.id, name: "Short-lived bot", scopes: ["read"], expiresInDays: 1 });
  for (const invalid of [undefined, null, 42, {}, "", "Bearer " + created.token, created.token + "x", "rl_mcp_" + "x".repeat(43)]) {
    assert.equal(f.credentials.authenticate(invalid), null);
  }
  f.setTime("2026-10-01T23:59:59.999Z");
  assert.ok(f.credentials.authenticate(created.token));
  f.setTime("2026-10-02T00:00:00.000Z");
  assert.equal(f.credentials.authenticate(created.token), null, "expiry is exclusive at the exact boundary");
  const other = f.credentials.create({ adminId: f.owner.id, name: "Revoked bot", scopes: ["read"] });
  const revoked = f.credentials.revoke(other.id);
  assert.equal(revoked.revokedAt, "2026-10-02T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(revoked), /token|hash|secret/i);
  assert.equal(f.credentials.authenticate(other.token), null);
  f.setTime("2026-10-03T00:00:00.000Z");
  assert.equal(f.credentials.revoke(other.id).revokedAt, revoked.revokedAt);
  f.reopen();
  assert.equal(f.credentials.authenticate(other.token), null);
  assert.equal(f.credentials.authenticate(created.token), null);
  assert.throws(() => f.credentials.revoke("missing"), { code: "MCP_CREDENTIAL_NOT_FOUND", statusCode: 404 });
});

test("MCP authentication reflects current administrator roles and lists credentials by administrator", async (t) => {
  const f = await fixture(t);
  const operator = f.store.createAdmin({ username: "operator", password: "test-password", role: "operator" });
  const ownerToken = f.credentials.create({ adminId: f.owner.id, name: "Owner bot", scopes: ["read"] });
  const operatorToken = f.credentials.create({ adminId: operator.id, name: "Operations bot", scopes: ["read", "runtime.manage"] });
  assert.deepEqual(f.credentials.list(operator.id).map(({ id }) => id), [operatorToken.id]);
  assert.deepEqual(f.credentials.list(f.owner.id).map(({ id }) => id), [ownerToken.id]);
  assert.equal(f.credentials.list().length, 2);
  assert.equal(f.credentials.authenticate(operatorToken.token).admin.role, "operator");
  f.store.updateAdmin(operator.id, { role: "auditor", username: "audit-user" });
  assert.deepEqual(f.credentials.authenticate(operatorToken.token).admin, {
    id: operator.id, username: "audit-user", role: "auditor"
  });
  assert.equal(f.credentials.list(operator.id)[0].adminUsername, "audit-user");
  f.credentials.close();
  assert.equal(f.store.listAdmins().length, 2, "closing credentials must not close the shared database");
});

test("MCP scope validation rejects sparse arrays without silently storing null permissions", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.credentials.create({ adminId: f.owner.id, name: "Bot", scopes: new Array(1) }), {
    code: "INVALID_MCP_SCOPES", statusCode: 422
  });
  assert.equal(f.credentials.list().length, 0);
});
