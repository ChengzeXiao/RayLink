import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { createRayLinkApp } from "../server/app.js";

test("shutdown drains a real modern MCP subscription without waiting for its client to disconnect", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-mcp-shutdown-"));
  const abort = new AbortController();
  let app;
  let closing;
  let deadline;
  try {
    app = await createRayLinkApp({
      dataDir, adminUsername: "admin", adminPassword: "shutdown-test-password",
      publicOrigin: "http://127.0.0.1", runtimeMode: "dry-run", singBoxBinary: join(dataDir, "missing"),
      backupIntervalMs: 0, alertIntervalMs: 0, runtimeUpdateCheckIntervalMs: 0, protocolLatencyIntervalMs: 0,
      installer: { async status() { return { installed: false, tags: [] }; } },
      ruleSetCache: { prepare: async () => {}, available: () => false, get: async () => null }
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "shutdown-test-password" }) });
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    const issued = await (await fetch(`${base}/api/mcp/tokens`, { method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Shutdown check", scopes: ["read"] }) })).json();
    const response = await fetch(`${base}/mcp`, {
      method: "POST", signal: abort.signal,
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28", "mcp-method": "subscriptions/listen" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: {
        _meta: { [CLIENT_INFO_META_KEY]: { name: "shutdown-test", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {}, [PROTOCOL_VERSION_META_KEY]: "2026-07-28" },
        notifications: { toolsListChanged: true }
      } })
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const acknowledgment = new TextDecoder().decode((await reader.read()).value);
    assert.match(acknowledgment, /notifications\/subscriptions\/acknowledged/);
    assert.match(acknowledgment, /"toolsListChanged":true/);
    assert.doesNotMatch(acknowledgment, /"resultType":"complete"/);
    closing = app.close();
    await Promise.race([closing, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Shutdown is waiting for an open MCP subscription")), 8_000);
    })]);
    clearTimeout(deadline);
    const frames = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      frames.push(new TextDecoder().decode(value));
    }
    assert.match(frames.join(""), /"resultType":"complete"/);
  } finally {
    clearTimeout(deadline);
    abort.abort();
    if (closing) await closing;
    else if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
