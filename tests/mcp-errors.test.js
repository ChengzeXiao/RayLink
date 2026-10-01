import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createRayLinkApp } from "../server/app.js";

test("ordinary MCP failures retain their code without exposing raw runtime command diagnostics", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-mcp-errors-"));
  let failInspection = false;
  let app;
  const client = new Client({ name: "error-safety-test", version: "1" });
  try {
    app = await createRayLinkApp({
      dataDir, adminUsername: "admin", adminPassword: "error-safety-test-password",
      publicOrigin: "http://127.0.0.1", runtimeMode: "dry-run", singBoxBinary: join(dataDir, "missing"),
      backupIntervalMs: 0, alertIntervalMs: 0, runtimeUpdateCheckIntervalMs: 0, protocolLatencyIntervalMs: 0,
      installer: { async status() {
        if (failInspection) throw Object.assign(new Error("command failed: config password=PRIVATE_RUNTIME_SENTINEL"), {
          code: "RUNTIME_INSPECTION_FAILED", statusCode: 503
        });
        return { installed: false, tags: [] };
      } },
      ruleSetCache: { prepare: async () => {}, available: () => false, get: async () => null }
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "error-safety-test-password" }) });
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    const issued = await (await fetch(`${base}/api/mcp/tokens`, { method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "No secret access", scopes: ["read"] }) })).json();
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } }
    }));
    failInspection = true;
    const result = await client.callTool({ name: "runtime_installation", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "RUNTIME_INSPECTION_FAILED");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_RUNTIME_SENTINEL|command failed|config password/);
  } finally {
    await client.close();
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
