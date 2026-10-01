import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
function shippedFunction(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `Missing shipped function ${name}`);
  const start = match.index;
  const ends = [source.indexOf("\nfunction ", start + 1), source.indexOf("\nasync function ", start + 1)].filter(value => value > start);
  return source.slice(start, Math.min(...ends));
}

// Exercise the actual form handler and reveal/close behavior across DOM/HTTP boundaries.
test("MCP Server reveals a standard HTTP Bearer configuration once, while list state has no plaintext", async () => {
  const nodes = Object.fromEntries(["#mcp-issued-token", "#mcp-issued-config", "#mcp-issued", "#mcp-token-list"].map(key => [key, { value: "", hidden: true, innerHTML: "", focus() {} }]));
  const context = { controlPlane: { currentAdmin: { id: "owner", role: "owner" } }, mcpAccess: { tokens: [], scopes: [{ id: "read", label: "读取" }], endpoint: "https://panel.example.com/mcp", issued: null, loading: false, creating: false, generation: 0 }, document: { querySelector: selector => nodes[selector] }, syncMcpCreateButton() {}, mcpSessionIsCurrent: () => true, escapeHtml: value => String(value), setText() {}, api: async () => ({ id: "token-1", name: "Browser fixture", token: "fixture-bearer-value", scopes: ["read"], expiresAt: "2099-01-01T00:00:00.000Z" }) };
  vm.runInNewContext(["renderMcpTokens", "clearMcpSecret", "createMcpCredential"].map(shippedFunction).join("\n"), context);
  await context.createMcpCredential({ preventDefault() {}, currentTarget: { elements: { name: { value: "Browser fixture" }, expiresInDays: { value: "30" } }, querySelectorAll: () => [{ value: "read" }] } });
  const config = JSON.parse(nodes["#mcp-issued-config"].value);
  assert.deepEqual(config.mcpServers.raylink, { type: "http", url: "https://panel.example.com/mcp", headers: { Authorization: "Bearer fixture-bearer-value" } });
  assert.equal(nodes["#mcp-issued-token"].value, "fixture-bearer-value");
  assert.equal(JSON.stringify(context.mcpAccess).includes("fixture-bearer-value"), false);
  assert.equal(nodes["#mcp-token-list"].innerHTML.includes("fixture-bearer-value"), false);
  context.clearMcpSecret();
  assert.equal(nodes["#mcp-issued-token"].value, "");
  assert.equal(nodes["#mcp-issued-config"].value, "");
  assert.equal(nodes["#mcp-issued"].hidden, true);
});
