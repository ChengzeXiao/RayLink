import assert from "node:assert/strict";
import test from "node:test";
import { mcpTools } from "../server/mcp-tools.js";
const find = (name) => { const tool = mcpTools.find((item) => item.name === name); assert.ok(tool, name); return tool; };

test("MCP can read and update AI upstreams without exposing proxy passwords", () => {
  const get = find("routing_ai_upstream_get");
  const update = find("routing_ai_upstream_update");
  assert.deepEqual(get.requiresScopes, ["read"]);
  assert.deepEqual(get.request({}), { method: "GET", path: "/api/settings/ai-upstream" });
  assert.deepEqual(update.requiresScopes, ["runtime.manage"]);
  assert.deepEqual(update.request({ requestId: "upstream-1", type: "https", enabled: true, server: "proxy.example.com", port: 443,
    username: "proxy-user", password: "private-upstream-password" }), {
    method: "PATCH", path: "/api/settings/ai-upstream", body: { type: "https", enabled: true, server: "proxy.example.com", port: 443,
      username: "proxy-user", password: "private-upstream-password" }
  });
  const result = update.select({ config: { enabled: true, type: "https", passwordConfigured: true, password: "private-upstream-password", encryptedPassword: "secret" },
    runtimeSync: { status: "pending", message: "请重试发布" } });
  assert.equal(result.upstream.passwordConfigured, true);
  assert.equal(result.runtimeSync.status, "pending");
  assert.doesNotMatch(JSON.stringify(result), /private-upstream-password|encryptedPassword|secret/);
  assert.equal(update.inputSchema.safeParse({ requestId: "bad", type: "socks4" }).success, false);
  assert.equal(update.inputSchema.safeParse({ requestId: "bad", insecure: true }).success, false);
  assert.equal(update.inputSchema.safeParse({ enabled: true }).success, false);
  assert.deepEqual(find("routing_ai_upstream_publish").request({ requestId: "publish-1" }), {
    method: "POST", path: "/api/settings/ai-upstream/publish"
  });
});
