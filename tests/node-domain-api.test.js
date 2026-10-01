import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createRayLinkApp } from "../server/app.js";

const password = "node-domain-test-" + "password";
const apiToken = "test-cloudflare-" + "private-value";
const setting = { provider: "cloudflare", zoneId: "a".repeat(32), baseDomain: "nodes.example.com", autoProvision: true, inheritProtocols: false };
const safeSettings = { ...setting, tokenConfigured: true };
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-node-domain-api-"));
  const app = await createRayLinkApp({
    dataDir, adminUsername: "admin", adminPassword: password,
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
  const login = async (username = "admin") => {
    const response = await api("", "/api/auth/login", "POST", { username, password });
    assert.equal(response.status, 200);
    return response.headers.getSetCookie()[0].split(";")[0];
  };
  const cookie = await login();
  const connect = async (scopes, credentialCookie = cookie) => {
    const response = await api(credentialCookie, "/api/mcp/tokens", "POST", { name: "Domain integration", scopes });
    assert.equal(response.status, 201);
    const issued = await response.json();
    const client = new Client({ name: "node-domain-tests", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } }
    }));
    return client;
  };
  return { api, cookie, login, connect };
}
const output = (result) => result.structuredContent || JSON.parse(result.content[0].text);
function noSecret(value) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(apiToken));
  assert.doesNotMatch(text, /apiToken|encryptedToken|Authorization|Bearer/);
}

test("HTTP node-domain settings expose safe state, retain blank tokens, and explicitly clear disabled credentials", async (t) => {
  const f = await fixture(t);
  const initial = await f.api(f.cookie, "/api/settings/node-domains");
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).nodeDomains.tokenConfigured, false);
  const updated = await f.api(f.cookie, "/api/settings/node-domains", "PATCH", { ...setting, apiToken });
  assert.equal(updated.status, 200);
  const value = await updated.json();
  assert.deepEqual(value, { nodeDomains: safeSettings });
  noSecret(value);
  const retained = await f.api(f.cookie, "/api/settings/node-domains", "PATCH", { apiToken: "", inheritProtocols: true });
  assert.equal(retained.status, 200);
  assert.deepEqual((await retained.json()).nodeDomains, { ...safeSettings, inheritProtocols: true });
  const cleared = await f.api(f.cookie, "/api/settings/node-domains", "PATCH", { provider: "disabled", clearToken: true });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await cleared.json()).nodeDomains, { ...setting, provider: "disabled", autoProvision: false, inheritProtocols: true, tokenConfigured: false });
  noSecret(await (await f.api(f.cookie, "/api/settings/node-domains")).json());
  noSecret(await (await f.api(f.cookie, "/api/audit")).json());
});

test("support can read safe DNS settings but cannot modify them over HTTP", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.api(f.cookie, "/api/settings/node-domains", "PATCH", { ...setting, apiToken })).status, 200);
  assert.equal((await f.api(f.cookie, "/api/admins", "POST", { username: "support-user", password, role: "support" })).status, 201);
  const support = await f.login("support-user");
  const read = await f.api(support, "/api/settings/node-domains");
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { nodeDomains: safeSettings });
  const forbidden = await f.api(support, "/api/settings/node-domains", "PATCH", { provider: "disabled", clearToken: true });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, "FORBIDDEN");
  assert.deepEqual(await (await f.api(f.cookie, "/api/settings/node-domains")).json(), { nodeDomains: safeSettings });
  assert.equal((await f.api("", "/api/settings/node-domains")).status, 401);
});

test("MCP reads and writes DNS settings with separate scopes, preserves safe token status and request identity", async (t) => {
  const f = await fixture(t);
  const reader = await f.connect(["read"]);
  const writer = await f.connect(["system.manage"]);
  try {
    const readerTools = (await reader.listTools()).tools.map((tool) => tool.name);
    const writerTools = (await writer.listTools()).tools.map((tool) => tool.name);
    assert.ok(readerTools.includes("node_domains_get"));
    assert.ok(!readerTools.includes("node_domains_update"));
    assert.ok(writerTools.includes("node_domains_update"));
    assert.ok(!writerTools.includes("node_domains_get"));
    await assert.rejects(reader.callTool({ name: "node_domains_update", arguments: { ...setting, apiToken, requestId: "forbidden-write" } }), { code: -32602 });
    const args = { ...setting, apiToken, requestId: "configure-node-dns" };
    const first = await writer.callTool({ name: "node_domains_update", arguments: args });
    assert.ok(!first.isError, JSON.stringify(first));
    assert.deepEqual(output(first), { nodeDomains: safeSettings });
    noSecret(first);
    const read = await reader.callTool({ name: "node_domains_get", arguments: {} });
    assert.deepEqual(output(read), { nodeDomains: safeSettings });
    noSecret(read);
    // An intentional later HTTP change must survive a transport retry of the old MCP write.
    assert.equal((await f.api(f.cookie, "/api/settings/node-domains", "PATCH", { provider: "disabled", clearToken: true })).status, 200);
    const retry = await writer.callTool({ name: "node_domains_update", arguments: args });
    assert.deepEqual(output(retry), output(first));
    noSecret(retry);
    const current = (await (await f.api(f.cookie, "/api/settings/node-domains")).json()).nodeDomains;
    assert.equal(current.provider, "disabled");
    assert.equal(current.tokenConfigured, false);
    const conflict = await writer.callTool({ name: "node_domains_update", arguments: { ...args, baseDomain: "different.example.com" } });
    assert.equal(conflict.isError, true);
    assert.equal(output(conflict).error.code, "REQUEST_ID_CONFLICT");
    noSecret(conflict);
    const audit = await (await f.api(f.cookie, "/api/audit")).json();
    noSecret(audit);
    assert.ok(audit.events.some((event) => event.action === "MCP node_domains_update" && event.metadata.replayed === true));
  } finally { await reader.close(); await writer.close(); }
});

test("an MCP token with system scope loses DNS write access when its Owner becomes support", async (t) => {
  const f = await fixture(t);
  const target = await (await f.api(f.cookie, "/api/admins", "POST", { username: "dns-operator", password, role: "owner" })).json();
  const targetCookie = await f.login("dns-operator");
  const client = await f.connect(["read", "system.manage"], targetCookie);
  try {
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "node_domains_update"));
    assert.equal((await f.api(f.cookie, `/api/admins/${target.id}`, "PATCH", { role: "support" })).status, 200);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes("node_domains_get"));
    assert.ok(!tools.includes("node_domains_update"));
    await assert.rejects(client.callTool({ name: "node_domains_update", arguments: { ...setting, apiToken, requestId: "demoted-admin-write" } }), { code: -32602 });
    assert.equal((await (await f.api(f.cookie, "/api/settings/node-domains")).json()).nodeDomains.tokenConfigured, false);
  } finally { await client.close(); }
});
