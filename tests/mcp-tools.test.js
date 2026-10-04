import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod/v4";
import { mcpTools } from "../server/mcp-tools.js";

const tool = (name) => {
  const found = mcpTools.find((entry) => entry.name === name);
  assert.ok(found, `Missing MCP tool ${name}`);
  return found;
};

test("MCP user creation validates explicit fields and keeps request identity out of the REST body", () => {
  const create = tool("users_create");
  const input = { requestId: "create-user-1", name: "Test User", email: "test@example.com", quotaGb: 100, nodeScope: ["all"], expiresAt: "2030-12-31" };
  assert.deepEqual(create.request(input), {
    method: "POST", path: "/api/users", body: {
      name: "Test User", email: "test@example.com", quotaGb: 100, nodeScope: ["all"], expiresAt: "2030-12-31"
    }
  });
  assert.equal(create.inputSchema.safeParse({ ...input, requestId: undefined }).success, false);
  assert.equal(create.inputSchema.safeParse({ ...input, quotaGb: 0 }).success, false);
  assert.equal(create.inputSchema.safeParse({ ...input, admin: true }).success, false);
  const selected = create.select({ id: "user-1", ...input, subscription: { secret: "SENSITIVE" }, runtimePassword: "SENSITIVE", runtimeSync: { status: "current" } });
  assert.equal(selected.id, "user-1");
  assert.equal(selected.runtimeSync.status, "current");
  assert.doesNotMatch(JSON.stringify(selected), /SENSITIVE|requestId/);
  assert.deepEqual(create.requiresScopes, ["users.manage"]);
});

test("MCP bootstrap views select their resource and do not expose credentials or privileged collections", () => {
  const bootstrap = {
    currentAdmin: { id: "admin-1", username: "support", role: "support" },
    users: [{ id: "user-1", name: "Test", subscription: { publicId: "SENSITIVE", secret: "SENSITIVE" } }],
    hosts: [{ id: "local", name: "Host", protocols: [{ type: "vless", tls: { mode: "reality", privateKey: "SENSITIVE", publicKey: "public" }, options: { password: "SENSITIVE" } }] }],
    admins: [{ password: "SENSITIVE" }], auditEvents: [{ metadata: { secret: "SENSITIVE" } }],
    runtime: { state: "running", runtimePassword: "SENSITIVE" },
    runtimePreview: { eligibleUsers: 1, config: { password: "SENSITIVE" } }
  };
  assert.deepEqual(tool("users_list").request({}), { method: "GET", path: "/api/bootstrap" });
  assert.deepEqual(tool("users_list").select(bootstrap), { users: [{ id: "user-1", name: "Test" }] });
  assert.deepEqual(tool("users_get").select(bootstrap, { userId: "user-1" }), { id: "user-1", name: "Test" });
  assert.throws(() => tool("users_get").select(bootstrap, { userId: "missing" }), (error) => error.statusCode === 404);
  const host = tool("hosts_get").select(bootstrap, { hostId: "local" });
  assert.equal(host.protocols[0].tls.publicKey, "public");
  assert.doesNotMatch(JSON.stringify(host), /SENSITIVE/);
  const overview = tool("system_overview").select(bootstrap);
  assert.doesNotMatch(JSON.stringify(overview), /SENSITIVE|auditEvents|"admins"/);
  assert.equal(overview.runtime.state, "running");
});

test("MCP account and enrollment operations preserve role permissions and require explicit secret scope", () => {
  assert.deepEqual(tool("users_update").request({ requestId: "update-1", userId: "user-1", state: "disabled" }), { method: "PATCH", path: "/api/users/user-1", body: { state: "disabled" } });
  assert.deepEqual(tool("users_reset_password").request({ requestId: "reset-1", userId: "user-1", password: "new-password" }), { method: "POST", path: "/api/users/user-1/password/reset", body: { password: "new-password" } });
  assert.deepEqual(tool("users_reset_password").select({ passwordReset: true, sessionsRevoked: 2 }), { passwordReset: true, sessionsRevoked: 2 });
  for (const [name, permission] of [["users_subscription_get", "read"], ["users_subscription_rotate", "users.manage"], ["hosts_create", "runtime.manage"], ["hosts_enrollment_rotate", "runtime.manage"]]) {
    const entry = tool(name);
    assert.equal(entry.permission, permission);
    assert.equal(entry.secret, true);
    assert.deepEqual(entry.requiresScopes, [permission, "secrets.read"]);
  }
  assert.deepEqual(tool("hosts_create").request({ requestId: "host-1", name: "Tokyo", address: "203.0.113.1", region: "tokyo" }), { method: "POST", path: "/api/hosts", body: { name: "Tokyo", address: "203.0.113.1", region: "tokyo" } });
  assert.equal(tool("hosts_create").inputSchema.safeParse({ requestId: "host-1", name: "Tokyo", address: "https://evil.example/path", region: "tokyo" }).success, false);
});

test("MCP protocol updates support complete managed TLS and transport fields with a bounded advanced-JSON escape hatch", () => {
  const update = tool("hosts_protocol_update");
  const input = { requestId: "protocol-1", hostId: "local", protocolType: "vless", enabled: true,
    tls: { mode: "reality", serverName: "example.com", handshakeServer: "example.com", handshakePort: 443, privateKey: "private", publicKey: "public", shortId: "abcd", acmeDataDirectory: "/var/lib/raylink/acme" },
    transport: { type: "grpc", serviceName: "rpc" }, options: { multiplex: { enabled: true }, tcp_fast_open: true } };
  const request = update.request(input);
  assert.equal(request.path, "/api/hosts/local/protocols/vless");
  assert.equal(request.body.tls.privateKey, "private");
  assert.deepEqual(request.body.options, input.options);
  for (const invalid of [{ ...input, tls: { ...input.tls, insecure: true } }, { ...input, transport: { ...input.transport, typo: true } }, { ...input, options: { users: [] } }, { ...input, protocolType: "shell" }]) {
    assert.equal(update.inputSchema.safeParse(invalid).success, false);
  }
  assert.doesNotMatch(JSON.stringify(update.select(request.body)), /private|multiplex/);
  assert.deepEqual(tool("hosts_protocol_get").requiresScopes, ["runtime.manage", "secrets.read"]);
});

test("MCP routing replacement validates every nested rule and preserves read-only diagnosis semantics", () => {
  const update = tool("routing_update");
  const args = { requestId: "routing-1", mode: "smart", unknownDomain: "resolve-geoip", rules: [{ id: "custom-1", match: "domain_suffix", value: "example.com", action: "proxy", dns: "remote", priority: 10, enabled: true, note: "Work" }] };
  assert.deepEqual(update.request(args), { method: "PATCH", path: "/api/settings/routing", body: { mode: "smart", unknownDomain: "resolve-geoip", rules: args.rules } });
  assert.equal(update.inputSchema.safeParse({ ...args, rules: [{ ...args.rules[0], command: "no" }] }).success, false);
  assert.equal(update.inputSchema.safeParse({ ...args, rules: Array(501).fill(args.rules[0]) }).success, false);
  assert.equal(tool("routing_diagnose").mutating, false);
  assert.equal(tool("routing_diagnose").permission, "runtime.manage");
  assert.deepEqual(tool("routing_diagnose").request({ domain: "example.com" }), { method: "POST", path: "/api/routing/diagnose", body: { domain: "example.com" } });
});

// Route families below are the authenticated administrator surface. Setup,
// login/logout, portal, Node-agent traffic, raw exports and MCP token issuance
// deliberately have no MCP tool. They use distinct authentication/lifecycles.
test("MCP operational catalog maps fixed routes and distinguishes permission from mutation", () => {
  const cases = [
    ["runtime_status", "GET", "/api/runtime/status", "read", false],
    ["runtime_installation", "GET", "/api/runtime/installation", "read", false],
    ["runtime_update_check", "GET", "/api/runtime/update", "read", false],
    ["runtime_install", "POST", "/api/runtime/install", "runtime.manage", true],
    ["runtime_upgrade", "POST", "/api/runtime/upgrade", "runtime.manage", true],
    ["runtime_reality_keypair", "POST", "/api/runtime/reality-keypair", "runtime.manage", true],
    ["deployments_list", "GET", "/api/deployments", "read", false],
    ["deployments_preview", "POST", "/api/deployments/preview", "runtime.manage", false],
    ["deployments_publish", "POST", "/api/deployments", "runtime.manage", true],
    ["deployments_rollback", "POST", "/api/deployments/deployment-1/rollback", "runtime.manage", true, { deploymentId: "deployment-1" }],
    ["backups_list", "GET", "/api/backups", "read", false],
    ["backups_create", "POST", "/api/backups", "system.manage", true],
    ["backups_verify", "POST", "/api/backups/raylink-20300101T120000-abcdef12.sqlite/verify", "system.manage", false, { filename: "raylink-20300101T120000-abcdef12.sqlite" }],
    ["alerts_get", "GET", "/api/alerts", "read", false],
    ["readiness_get", "GET", "/api/operations/readiness", "read", false],
    ["admins_list", "GET", "/api/admins", "admins.manage", false],
    ["audit_list", "GET", "/api/audit?limit=25", "audit.read", false, { limit: 25 }]
  ];
  for (const [name, method, path, permission, mutating, fields = {}] of cases) {
    const entry = tool(name);
    assert.equal(entry.permission, permission, name);
    assert.equal(entry.mutating, mutating, name);
    assert.deepEqual(entry.request({ ...fields, ...(mutating ? { requestId: "operation-1" } : {}) }), { method, path }, name);
  }
  assert.deepEqual(tool("admins_create").request({ requestId: "admin-create", username: "operator-1", role: "operator", password: "secure-test-password" }), { method: "POST", path: "/api/admins", body: { username: "operator-1", role: "operator", password: "secure-test-password" } });
  assert.deepEqual(tool("admins_update").request({ requestId: "admin-update", adminId: "admin-1", role: "auditor" }), { method: "PATCH", path: "/api/admins/admin-1", body: { role: "auditor" } });
  assert.deepEqual(tool("runtime_reality_keypair").requiresScopes, ["runtime.manage", "secrets.read"]);
  assert.equal(tool("backups_verify").inputSchema.safeParse({ filename: "../../raylink.db" }).success, false);
});

test("MCP secret protocol lookup fails closed when the selected protocol is absent", () => {
  assert.throws(() => tool("hosts_protocol_get").select({ hosts: [{ id: "local", protocols: [] }], admins: [{ password: "SENSITIVE" }] }, { hostId: "local", protocolType: "vless" }), (error) => error.statusCode === 404);
});

test("every published tool has a closed SDK-compatible schema and explicit mutation and secret gates", () => {
  assert.equal(new Set(mcpTools.map((entry) => entry.name)).size, mcpTools.length);
  for (const entry of mcpTools) {
    const schema = z.toJSONSchema(entry.inputSchema);
    assert.equal(schema.type, "object", entry.name);
    assert.equal(schema.additionalProperties, false, entry.name);
    assert.equal(schema.required?.includes("requestId") || false, entry.mutating, entry.name);
    assert.equal(entry.requiresScopes.includes("secrets.read"), entry.secret, entry.name);
    assert.ok(entry.requiresScopes.includes(entry.permission), entry.name);
    assert.ok(!["url", "method", "command"].some((field) => Object.hasOwn(schema.properties, field)), entry.name);
    assert.equal(typeof entry.select, "function", entry.name);
  }
  const payload = { deployments: [{ id: "deployment-1", status: "failed", error: "SENSITIVE", configJson: { users: [{ password: "SENSITIVE" }] }, targets: [{ status: "failed", error: "SENSITIVE", tls: { private_key: "SENSITIVE" } }] }] };
  const selected = tool("deployments_list").select(payload);
  assert.equal(selected.deployments[0].status, "failed");
  assert.equal(selected.deployments[0].errorPresent, true);
  assert.doesNotMatch(JSON.stringify(selected), /SENSITIVE/);
  assert.deepEqual(payload.deployments[0].targets[0].tls, { private_key: "SENSITIVE" });
});

test("AI egress tool views retain safe compilation error codes for recovery", () => {
  const runtimeSync = { status: "pending", errorCode: "AI_UPSTREAM_SECRET_UNAVAILABLE", message: "重新填写住宅密码后重试" };
  for (const name of ["routing_ai_egress_get", "routing_ai_upstream_get"]) {
    const value = tool(name).select({ mode: "residential", aiExit: { mode: "pinned", hostId: "local" }, config: {}, upstream: {}, runtimeSync });
    assert.equal(value.runtimeSync.errorCode, "AI_UPSTREAM_SECRET_UNAVAILABLE");
  }
});
