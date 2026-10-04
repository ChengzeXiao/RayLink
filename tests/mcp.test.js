import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRayLinkApp } from "../server/app.js";

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-mcp-"));
  const options = {
    dataDir, adminUsername: "admin", adminPassword: "test-admin-password-123",
    publicOrigin: "http://127.0.0.1", runtimeMode: "dry-run",
    singBoxBinary: join(dataDir, "no-runtime"),
    backupIntervalMs: 0, alertIntervalMs: 0, runtimeUpdateCheckIntervalMs: 0,
    installer: { async status() { return { installed: false, tags: [] }; } },
    ruleSetCache: { prepare: async () => {}, available: () => false, get: async () => null },
    ...overrides
  };
  let app = await createRayLinkApp(options);
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-admin-password-123" }) });
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const api = (path, method = "GET", body) => fetch(`${base}${path}`, {
    method, headers: { cookie, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const state = { app, base, api, cookie, dataDir, async restart() {
    await app.close();
    app = await createRayLinkApp(options);
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${app.server.address().port}`;
    state.app = app; state.base = base;
  } };
  return state;
}

test("owner issues a separate revocable MCP token; browser cookies do not authorize MCP", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/mcp`, { method: "POST", headers: { cookie: f.cookie } })).status, 401);
  const created = await f.api("/api/mcp/tokens", "POST", { name: "Read-only agent", scopes: ["read"], expiresInDays: 7 });
  assert.equal(created.status, 201);
  const credential = await created.json();
  assert.match(credential.token, /^rl_mcp_/);
  const listing = await (await f.api("/api/mcp/tokens")).json();
  assert.equal(listing.tokens.length, 1);
  assert.equal(listing.tokens[0].name, "Read-only agent");
  assert.ok(listing.endpoint.endsWith("/mcp"));
  assert.doesNotMatch(JSON.stringify(listing), /rl_mcp_|tokenHash|token_hash/);
  assert.equal((await f.api(`/api/mcp/tokens/${credential.id}`, "DELETE")).status, 200);
  assert.equal((await fetch(`${f.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${credential.token}` } })).status, 401);
});

async function connect(t, f, scopes, existing) {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const issued = existing || await (await f.api("/api/mcp/tokens", "POST", { name: "MCP integration", scopes })).json();
  const client = new Client({ name: "raylink-test-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${issued.token}` } }
  }));
  t.after(() => client.close());
  return { client, issued };
}
const output = (result) => result.structuredContent || JSON.parse(result.content[0].text);

test("AI diagnostics are scoped read-only MCP operations with explicit server-side evidence", async (t) => {
  const f = await fixture(t, { aiDiagnosticProbe: {
    resolve: async () => [{ address: "1.1.1.1", family: 4 }],
    request: async () => ({ httpStatus: 403, headers: { "cf-mitigated": "challenge" }, body: "" })
  } });
  assert.equal((await fetch(`${f.base}/api/routing/ai-check`)).status, 401);
  const { client: reader } = await connect(t, f, ["read"]);
  const readTools = (await reader.listTools()).tools.map((tool) => tool.name);
  assert.ok(readTools.includes("routing_ai_status"));
  assert.ok(!readTools.includes("routing_ai_check"));
  const { client } = await connect(t, f, ["read", "runtime.manage"]);
  const report = output(await client.callTool({ name: "routing_ai_check", arguments: { service: "claude" } }));
  assert.equal(report.source, "control-plane-egress");
  assert.equal(report.clientMeasured, false);
  assert.equal(report.authenticated, false);
  assert.ok(report.results.length >= 1);
  assert.ok(report.results.every((result) => result.status === "challenge"));
  const status = output(await reader.callTool({ name: "routing_ai_status", arguments: {} }));
  assert.deepEqual(status.report, report);
  const invalid = await f.api("/api/routing/ai-check", "POST", { service: "http://127.0.0.1" });
  assert.equal(invalid.status, 422);
  assert.equal((await f.api("/api/routing/ai-check", "POST", { url: "http://127.0.0.1" })).status, 422);
  assert.equal((await f.api("/api/routing/ai-check", "POST", [])).status, 422);
});

test("MCP can pin AI to a stable Host ID and older policy writes preserve the pin", async (t) => {
  const f = await fixture(t);
  const { client } = await connect(t, f, ["read", "runtime.manage"]);
  const saved = await client.callTool({ name: "routing_update", arguments: {
    requestId: "pin-ai-host", mode: "smart", rules: [], aiExit: { mode: "pinned", hostId: "local" }
  } });
  assert.ok(!saved.isError, JSON.stringify(saved));
  assert.deepEqual(output(saved).aiExit, { mode: "pinned", hostId: "local" });
  const legacy = await client.callTool({ name: "routing_update", arguments: {
    requestId: "legacy-policy-save", mode: "smart", rules: []
  } });
  assert.ok(!legacy.isError, JSON.stringify(legacy));
  assert.deepEqual(output(legacy).aiExit, { mode: "pinned", hostId: "local" });
  assert.equal((await f.api("/api/settings/routing", "PATCH", {
    mode: "smart", rules: [], aiExit: { mode: "pinned", hostId: "missing" }
  })).status, 422);
});

test("MCP AI upstream writes are scoped and replay without re-publishing or exposing proxy credentials", async (t) => {
  const f = await fixture(t);
  const { client: reader } = await connect(t, f, ["read"]);
  const names = (await reader.listTools()).tools.map((item) => item.name);
  assert.ok(names.includes("routing_ai_upstream_get"));
  assert.ok(!names.includes("routing_ai_upstream_update"));
  assert.ok(!names.includes("routing_ai_upstream_publish"));
  const { client } = await connect(t, f, ["read", "runtime.manage"]);
  const args = { requestId: "save-ai-upstream", enabled: true, type: "socks5", server: "proxy.example.com", port: 1080,
    username: "proxy-user", password: "private-residential-password" };
  const first = await client.callTool({ name: "routing_ai_upstream_update", arguments: args });
  assert.ok(!first.isError, JSON.stringify(first));
  assert.equal(output(first).upstream.passwordConfigured, true);
  assert.equal(output(first).runtimeSync.status, "simulated");
  const deployments = output(await client.callTool({ name: "deployments_list", arguments: {} })).deployments.length;
  assert.deepEqual(output(await client.callTool({ name: "routing_ai_upstream_update", arguments: args })), output(first));
  assert.equal(output(await client.callTool({ name: "deployments_list", arguments: {} })).deployments.length, deployments);
  const observed = output(await reader.callTool({ name: "routing_ai_upstream_get", arguments: {} }));
  assert.equal(observed.upstream.enabled, true);
  assert.doesNotMatch(JSON.stringify(observed), /private-residential-password/);
  await assert.rejects(reader.callTool({ name: "routing_ai_upstream_update", arguments: { requestId: "denied", enabled: false } }),
    (error) => error.code === -32602);
  assert.equal(output(await reader.callTool({ name: "routing_ai_upstream_get", arguments: {} })).upstream.enabled, true);
});

test("MCP AI egress provides one exclusive scoped switch and safe idempotent responses", async (t) => {
  const f = await fixture(t);
  const { client: reader } = await connect(t, f, ["read"]);
  const names = (await reader.listTools()).tools.map((item) => item.name);
  assert.ok(names.includes("routing_ai_egress_get"));
  assert.ok(!names.includes("routing_ai_egress_update"));
  assert.ok(!names.includes("routing_ai_egress_publish"));
  const { client } = await connect(t, f, ["read", "runtime.manage"]);
  const args = { requestId: "unified-residential", mode: "residential", upstream: {
    type: "socks5", server: "proxy.example.com", port: 1080, username: "proxy-user", password: "private-unified-password"
  } };
  const first = await client.callTool({ name: "routing_ai_egress_update", arguments: args });
  assert.ok(!first.isError, JSON.stringify(first));
  assert.equal(output(first).mode, "residential");
  assert.equal(output(first).upstream.passwordConfigured, true);
  assert.equal(output(first).runtimeSync.publishedMode, "residential");
  assert.equal(output(first).runtimeSync.status, "simulated");
  const deployments = output(await client.callTool({ name: "deployments_list", arguments: {} })).deployments.length;
  assert.deepEqual(output(await client.callTool({ name: "routing_ai_egress_update", arguments: args })), output(first));
  assert.equal(output(await client.callTool({ name: "deployments_list", arguments: {} })).deployments.length, deployments);
  await assert.rejects(reader.callTool({ name: "routing_ai_egress_update", arguments: { requestId: "denied", mode: "server" } }), error => error.code === -32602);
  const server = await client.callTool({ name: "routing_ai_egress_update", arguments: { requestId: "unified-server", mode: "server", aiExit: { mode: "auto" } } });
  assert.ok(!server.isError, JSON.stringify(server));
  assert.equal(output(server).mode, "server");
  assert.equal(output(server).upstream.enabled, false);
  assert.equal(output(server).upstream.passwordConfigured, true);
  const observed = output(await reader.callTool({ name: "routing_ai_egress_get", arguments: {} }));
  assert.equal(observed.runtimeSync.publishedMode, "server");
  assert.doesNotMatch(JSON.stringify([first, server, observed]), /private-unified-password/);
  const retry = await client.callTool({ name: "routing_ai_egress_publish", arguments: { requestId: "unified-retry" } });
  assert.ok(!retry.isError, JSON.stringify(retry));
});

test("official MCP client discovers scoped tools and creates a User through the same entitlement workflow", async (t) => {
  const f = await fixture(t);
  const { client } = await connect(t, f, ["read", "users.manage"]);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(tools.includes("users_create"));
  assert.ok(!tools.includes("hosts_create"));
  assert.ok(!tools.includes("admins_create"));
  assert.ok(!tools.includes("users_subscription_get"));
  const created = await client.callTool({ name: "users_create", arguments: {
    requestId: "create-user-001", name: "MCP User", email: "mcp@example.test",
    quotaGb: 100, expiresAt: "2099-01-01", nodeScope: ["all"]
  } });
  assert.ok(!created.isError, JSON.stringify(created));
  const user = output(created);
  assert.equal(user.name, "MCP User");
  assert.ok(["published", "current", "pending"].includes(user.runtimeSync.status));
  assert.doesNotMatch(JSON.stringify(user), /runtimePassword|runtimeUuid|subscriptionUrl/);
  const listing = output(await client.callTool({ name: "users_list", arguments: {} }));
  assert.equal(listing.users.filter((entry) => entry.email === "mcp@example.test").length, 1);
  const audited = await (await f.api("/api/audit")).json();
  assert.ok(audited.events.some((entry) => entry.action === "MCP users_create"));
});

test("retrying a write concurrently replays one outcome; reusing its id with different input is rejected", async (t) => {
  const f = await fixture(t);
  const { client } = await connect(t, f, ["read", "users.manage"]);
  const arguments_ = { requestId: "retry-user-001", name: "Retry User", email: "retry@example.test", quotaGb: 50, expiresAt: "2099-01-01", nodeScope: ["all"] };
  const call = () => client.callTool({ name: "users_create", arguments: arguments_ });
  const first = await call();
  assert.ok(!first.isError, JSON.stringify(first));
  const replays = await Promise.all([call(), call()]);
  for (const replay of replays) assert.deepEqual(output(replay), output(first));
  const conflict = await client.callTool({ name: "users_create", arguments: { ...arguments_, quotaGb: 75 } });
  assert.equal(conflict.isError, true);
  assert.equal(output(conflict).error.code, "REQUEST_ID_CONFLICT");
  const users = output(await client.callTool({ name: "users_list", arguments: {} }));
  assert.equal(users.users.filter((entry) => entry.email === arguments_.email).length, 1);
});

test("Host enrollment credentials replay across a server restart without plaintext persistence", async (t) => {
  const f = await fixture(t);
  const { client, issued } = await connect(t, f, ["read", "runtime.manage", "secrets.read"]);
  const args = { requestId: "host-create-001", name: "MCP Host", address: "203.0.113.71", region: "singapore" };
  const created = await client.callTool({ name: "hosts_create", arguments: args });
  assert.ok(!created.isError, JSON.stringify(created));
  assert.ok(output(created).enrollmentToken);
  await client.close();
  await f.restart();
  const resumed = await connect(t, f, [], issued);
  assert.deepEqual(output(await resumed.client.callTool({ name: "hosts_create", arguments: args })), output(created));
  const listing = output(await resumed.client.callTool({ name: "hosts_list", arguments: {} }));
  assert.equal(listing.hosts.filter((host) => host.address === args.address).length, 1);
  // Inspect persisted artifacts only to assert the security storage contract.
  const { readFile } = await import("node:fs/promises");
  for (const suffix of ["", "-wal"]) {
    const persisted = await readFile(join(f.dataDir, `raylink.db${suffix}`)).catch(() => Buffer.alloc(0));
    assert.ok(!persisted.includes(Buffer.from(issued.token)));
    assert.ok(!persisted.includes(Buffer.from(output(created).enrollmentToken)));
  }
});

test("HTTP MCP rejects hostile origins, host rebinding, oversized payloads, unknown tools and invalid schemas", async (t) => {
  const f = await fixture(t);
  const { client, issued } = await connect(t, f, ["read", "users.manage"]);
  const headers = { authorization: `Bearer ${issued.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const request = (extra, body = { jsonrpc: "2.0", id: 1, method: "tools/list" }) => fetch(`${f.base}/mcp`, { method: "POST", headers: { ...headers, ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });
  assert.equal((await request({ origin: "https://evil.example" })).status, 403);
  const { request: nodeRequest } = await import("node:http");
  const reboundStatus = await new Promise((resolve, reject) => {
    const outgoing = nodeRequest(`${f.base}/mcp`, { method: "POST", headers: { ...headers, host: "evil.example" } }, (response) => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    outgoing.on("error", reject); outgoing.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await request({}, "x".repeat(256 * 1024 + 1))).status, 413);
  assert.equal((await fetch(`${f.base}/mcp`, { headers })).status, 405);
  await assert.rejects(client.callTool({ name: "arbitrary_http_request", arguments: { url: "http://internal/" } }));
  const invalid = await client.callTool({ name: "users_create", arguments: { name: "missing request id" } }).catch((error) => error);
  assert.ok(invalid.isError || invalid instanceof Error);
});

test("an already-connected agent immediately loses privileged tools after its owner is downgraded", async (t) => {
  const f = await fixture(t);
  const { client, issued } = await connect(t, f, ["read", "users.manage", "admins.manage", "secrets.read"]);
  await f.api("/api/admins", "POST", { username: "backup-owner", password: "{{SECRET_e95zuxca}}", role: "owner" });
  assert.equal((await f.api(`/api/admins/${issued.adminId}`, "PATCH", { role: "auditor" })).status, 200);
  const denied = await client.callTool({ name: "users_create", arguments: {
    requestId: "downgraded-001", name: "Denied", email: "denied@example.test", quotaGb: 1, expiresAt: "2099-01-01", nodeScope: ["all"]
  } }).catch((error) => error);
  assert.ok(denied.isError || denied instanceof Error);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(!tools.includes("users_create"));
  assert.ok(!tools.includes("users_subscription_get"));
  assert.equal((await f.api("/api/mcp/tokens", "POST", { name: "forbidden", scopes: ["read"] })).status, 403);
});

async function rpc(f, token, message, headers = {}) {
  const response = await fetch(`${f.base}/mcp`, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers
  }, body: JSON.stringify(message) });
  const raw = await response.text();
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(raw.split("\n").find((line) => line.startsWith("data: ")).slice(6))
    : raw ? JSON.parse(raw) : null;
  return { response, json };
}

test("legacy 2025 Streamable HTTP initialize, notifications and tool calls remain interoperable", async (t) => {
  const f = await fixture(t);
  const issued = await (await f.api("/api/mcp/tokens", "POST", { name: "Legacy agent", scopes: ["read"] })).json();
  const init = await rpc(f, issued.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" }
  } });
  assert.equal(init.response.status, 200);
  assert.equal(init.json.result.protocolVersion, "2025-11-25");
  assert.equal(init.response.headers.get("mcp-session-id"), null);
  const notification = await rpc(f, issued.token, { jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-protocol-version": "2025-11-25" });
  assert.equal(notification.response.status, 202);
  const called = await rpc(f, issued.token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "users_list", arguments: {} } }, { "mcp-protocol-version": "2025-11-25" });
  assert.equal(called.response.status, 200);
  assert.ok(Array.isArray(output(called.json.result).users));
});

test("Agent manages routing, certificates, protocol publication and rollback, backups, and administrator roles over MCP", async (t) => {
  const f = await fixture(t, {
    installer: { async status() { return { installed: true, version: "1.14.2", platform: "linux", architecture: "amd64", tags: ["with_quic", "with_utls", "with_acme"] }; } }
  });
  const { client } = await connect(t, f, ["read", "users.manage", "runtime.manage", "hosts.provision", "system.manage", "admins.manage", "audit.read", "secrets.read"]);
  assert.equal((await client.listTools()).tools.length, 63);
  let sequence = 0;
  const call = async (name, args = {}, write = false) => {
    const response = await client.callTool({ name, arguments: { ...args, ...(write ? { requestId: `workflow-${++sequence}` } : {}) } });
    assert.ok(!response.isError, `${name}: ${JSON.stringify(response)}`);
    return output(response);
  };
  const user = await call("users_create", { name: "Managed User", email: "managed@example.test", quotaGb: 25, expiresAt: "2099-01-01", nodeScope: ["all"], password: "{{SECRET_xgoikhqq}}" }, true);
  assert.equal((await call("users_update", { userId: user.id, quotaGb: 75 }, true)).quotaGb, 75);
  assert.equal((await call("users_get", { userId: user.id })).quotaGb, 75);
  assert.equal((await call("users_reset_password", { userId: user.id, password: "{{SECRET_dm02hi15}}" }, true)).passwordReset, true);
  const subscription = await call("users_subscription_rotate", { userId: user.id }, true);
  assert.equal((await call("users_subscription_get", { userId: user.id })).subscriptionUrl, subscription.subscriptionUrl);
  assert.ok(subscription.formats.mihomo);
  assert.notEqual((await call("users_subscription_rotate", { userId: user.id }, true)).subscriptionUrl, subscription.subscriptionUrl);
  const rules = [{ id: "mcp-rule", match: "domain_suffix", value: "example.com", action: "proxy", dns: "remote", enabled: true }];
  await call("routing_update", { mode: "smart", rules }, true);
  assert.equal((await call("routing_get")).policy.rules[0].value, "example.com");
  assert.equal((await call("routing_diagnose", { domain: "app.example.com" })).action, "proxy");
  await call("certificate_update", { email: "acme@example.test" }, true);
  assert.equal((await call("certificate_get")).email, "acme@example.test");
  await call("hosts_update", { hostId: "local", name: "MCP Local", region: "tokyo" }, true);
  assert.equal((await call("hosts_get", { hostId: "local" })).name, "MCP Local");
  const profile = await call("hosts_protocol_update", { hostId: "local", protocolType: "shadowsocks", enabled: true, port: 18443, tls: { mode: "none" }, transport: { type: "none" } }, true);
  assert.equal(profile.port, 18443);
  assert.equal((await call("hosts_protocol_get", { hostId: "local", protocolType: "shadowsocks" })).port, 18443);
  const preview = await call("deployments_preview");
  assert.ok(preview.inboundCount >= 1);
  const published = await call("deployments_publish", {}, true);
  assert.ok(published.id);
  assert.equal((await call("runtime_status")).state, "staged");
  await call("hosts_protocol_update", { hostId: "local", protocolType: "shadowsocks", port: 18444 }, true);
  await call("deployments_publish", {}, true);
  const rolledBack = await call("deployments_rollback", { deploymentId: published.id }, true);
  assert.notEqual(rolledBack.id, published.id);
  assert.equal((await call("deployments_list")).deployments[0].id, rolledBack.id);
  const backup = await call("backups_create", {}, true);
  assert.equal((await call("backups_verify", { filename: backup.filename })).valid, true);
  assert.ok((await call("backups_list")).backups.some((entry) => entry.filename === backup.filename));
  const admin = await call("admins_create", { username: "mcp-support", password: "{{SECRET_dwu8im5w}}", role: "support" }, true);
  await call("admins_update", { adminId: admin.id, role: "auditor" }, true);
  assert.equal((await call("admins_list")).admins.find((entry) => entry.id === admin.id).role, "auditor");
  assert.ok((await call("audit_list", { limit: 100 })).events.some((entry) => entry.action === "MCP deployments_rollback"));
  assert.equal((await call("readiness_get")).schemaVersion, 1);
  assert.ok(Array.isArray((await call("alerts_get")).alerts));
  assert.ok((await call("system_overview")).hostCount >= 1);
  assert.equal((await call("runtime_certificates")).status, "disabled");
  assert.equal((await call("runtime_certificates_sync", {}, true)).status, "disabled");
});
