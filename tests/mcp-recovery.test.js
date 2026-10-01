import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

function waitForMessage(child, type) {
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timeout);
      child.off("message", message);
      child.off("exit", exit);
      child.off("error", fail);
    };
    const fail = (error) => { clean(); reject(error); };
    const message = (value) => { if (value?.type === type) { clean(); resolve(value); } };
    const exit = (code, signal) => fail(new Error(`Recovery fixture exited before ${type}: ${code ?? signal}`));
    const timeout = setTimeout(() => fail(new Error(`Recovery fixture timed out waiting for ${type}`)), 10_000);
    child.on("message", message);
    child.once("exit", exit);
    child.once("error", fail);
  });
}

async function kill(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const stopped = once(server.child, "exit");
  server.child.kill("SIGKILL");
  const [, signal] = await stopped;
  assert.equal(signal, "SIGKILL");
}

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-mcp-recovery-"));
  const servers = [];
  const clients = [];
  t.after(async () => {
    await Promise.all(servers.map(kill));
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    await rm(dataDir, { recursive: true, force: true });
  });
  async function start() {
    const child = fork(new URL("./fixtures/mcp-recovery-server.mjs", import.meta.url), [dataDir], {
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    const server = { child, base: null };
    servers.push(server);
    let diagnostics = "";
    child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4_000); });
    try { server.base = (await waitForMessage(child, "ready")).base; }
    catch (error) { throw new Error(`${error.message}\n${diagnostics}`); }
    server.command = async (type, reply) => {
      const result = waitForMessage(child, reply);
      child.send({ type });
      return result;
    };
    return server;
  }
  async function connect(server, token) {
    const client = new Client({ name: "raylink-recovery-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    }));
    return client;
  }
  const server = await start();
  const login = await fetch(`${server.base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "test-password" }), signal: AbortSignal.timeout(10_000)
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const post = (path, body) => fetch(`${server.base}${path}`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000)
  });
  const initialDeployment = await post("/api/deployments", {});
  assert.equal(initialDeployment.status, 201);
  assert.equal((await initialDeployment.json()).status, "active", "an initial deployment is required to exercise user-triggered reconciliation");
  const issued = await post("/api/mcp/tokens", { name: "Recovery agent", scopes: ["read", "users.manage"] });
  assert.equal(issued.status, 201);
  const { token } = await issued.json();
  return { server, token, start, connect, client: await connect(server, token) };
}

const output = (result) => result.structuredContent || JSON.parse(result.content[0].text);
const createArguments = (prefix) => ({
  requestId: `${prefix}-create-001`, name: "Recovery User", email: `${prefix}@example.test`,
  quotaGb: 50, expiresAt: "2099-01-01", nodeScope: ["all"], portalStatus: "active", state: "active"
});

test("MCP write killed after saving returns unknown outcome after process restart without executing again", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const args = createArguments("crash");
  await f.server.command("gate-next-publication", "armed");
  const blocked = waitForMessage(f.server.child, "publication-blocked");
  const interrupted = f.client.callTool({ name: "users_create", arguments: args }).catch((error) => error);
  await blocked;
  const beforeCrash = output(await f.client.callTool({ name: "users_list", arguments: {} }));
  assert.equal(beforeCrash.users.filter((user) => user.email === args.email).length, 1);
  await kill(f.server);
  assert.ok(await interrupted instanceof Error, "the original HTTP request must be interrupted by SIGKILL");
  const restarted = await f.start();
  const resumed = await f.connect(restarted, f.token);
  const replay = await resumed.callTool({ name: "users_create", arguments: args });
  assert.equal(replay.isError, true);
  assert.equal(output(replay).error.code, "OPERATION_OUTCOME_UNKNOWN");
  const listing = output(await resumed.callTool({ name: "users_list", arguments: {} }));
  assert.equal(listing.users.filter((user) => user.email === args.email).length, 1);
});

test("disconnecting an HTTP MCP writer does not cancel its persisted operation and its retry replays completion", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const args = createArguments("disconnect");
  await f.server.command("gate-next-publication", "armed");
  const blocked = waitForMessage(f.server.child, "publication-blocked");
  const controller = new AbortController();
  const disconnected = fetch(`${f.server.base}/mcp`, {
    method: "POST", signal: controller.signal,
    headers: { Authorization: `Bearer ${f.token}`, "content-type": "application/json",
      accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "disconnect-write", method: "tools/call", params: { name: "users_create", arguments: args } })
  }).then((response) => response.text()).catch((error) => error);
  await blocked;
  controller.abort();
  assert.ok(await disconnected instanceof Error, "the client must disconnect before Runtime publication is released");
  await f.server.command("release-publication", "released");
  const replay = await f.client.callTool({ name: "users_create", arguments: args });
  assert.ok(!replay.isError, JSON.stringify(replay));
  assert.equal(output(replay).runtimeSync.status, "published");
  assert.deepEqual(output(await f.client.callTool({ name: "users_create", arguments: args })), output(replay));
  const listing = output(await f.client.callTool({ name: "users_list", arguments: {} }));
  assert.equal(listing.users.filter((user) => user.email === args.email).length, 1);
});
