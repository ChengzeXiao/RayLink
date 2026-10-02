import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createRayLinkApp } from "../server/app.js";
import { AGENT_VERSION, RayLinkNode } from "../web/node/raylink-node.mjs";

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-provision-"));
  let base, node, pump, stopped = false, published = false;
  const installations = [], publications = [];
  const sshBootstrap = { async connect(input) {
    if (input.password === "wrong") throw Object.assign(new Error("raw password MUST NOT LEAK"), { code: "SSH_AUTH_FAILED" });
    return { fingerprint: `SHA256:${"a".repeat(43)}`, close() {},
      async preflight() { return { existing: null }; },
      async install(input) {
        installations.push(input);
        node = new RayLinkNode({ serverUrl: base, enrollmentToken: input.enrollmentToken,
          statePath: join(dataDir, "test-node.json"),
          metadataProvider: async () => ({ hostname: "test-vps", platform: "linux", architecture: "x64", agentVersion: AGENT_VERSION,
            runtimeVersion: "1.14.2", buildTags: overrides.buildTags || ["with_v2ray_api"], runtimeState: published ? "running" : "stopped",
            telemetry: { serviceStatus: published ? "running" : "stopped" } }),
          usageCollector: { async collect() { return { sampleId: randomUUID(), runtimeInstanceId: "test-runtime", observedAt: new Date().toISOString(), users: [] }; } },
          runtimeAdapter: { async publish(payload) {
            publications.push(payload);
            if (overrides.nodePublish) await overrides.nodePublish(payload, publications.length);
            published = true;
            return { runtimeVersion: "1.14.2", activation: { publicCheck: { reachable: true, probe: "sing-box-tools-fetch" } } };
          } }
        });
        await node.pollOnce().catch((error) => { t.diagnostic(error.stack); throw error; });
        pump = (async () => { while (!stopped) { await delay(15); if (!stopped) await node.pollOnce(); } })().catch((error) => { t.diagnostic(error.stack); });
      }
    };
  } };
  const app = await createRayLinkApp({ dataDir, adminUsername: "admin", adminPassword: "Provision-test-only!",
    publicOrigin: "https://panel.example.com", runtimeMode: "dry-run", singBoxBinary: join(dataDir, "none"), seedDemoData: false,
    backupIntervalMs: 0, alertIntervalMs: 0, runtimeUpdateCheckIntervalMs: 0, entitlementReconcileIntervalMs: 0,
    ruleSetCache: { prepare: async () => {}, available: () => false, get: async () => null },
    installer: { async status() { return { installed: false, tags: [] }; } },
    endpointResolver: { async resolve({ fallbackAddress }) { return fallbackAddress ? { address: fallbackAddress } : null; } },
    protocolProbe: async () => ({ reachable: true, latencyMs: 12, probe: "sing-box-tools-fetch" }),
    sshBootstrap, provisioningPollMs: 15, provisioningWaitMs: 3000, nodeHeartbeatMinIntervalMs: 0, ...overrides });
  // Model a configured control plane that explicitly allows its local test listener.
  for (const [key, value] of [["canonical_origin", "https://panel.example.com"], ["allowed_origins", '["http://127.0.0.1"]']]) {
    app.store.db.prepare("INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value, new Date().toISOString());
  }
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { stopped = true; await pump; await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "Provision-test-only!" }) });
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const api = (path, method = "GET", body) => fetch(`${base}${path}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const start = (patch = {}) => api("/api/hosts/provision", "POST", { requestId: "ssh-test-1", host: "203.0.113.42", username: "root", password: "ssh-secret-only-memory", ...patch });
  const finish = async (id) => {
    for (let i = 0; i < 400; i++) {
      const { job } = await (await api(`/api/hosts/provision/${id}`)).json();
      if (!["queued", "running"].includes(job.status)) return job;
      await delay(15);
    }
    throw new Error("Provision job did not settle");
  };
  return { app, api, start, finish, installations, publications, dataDir, base };
}

test("SSH onboarding enrolls the real Node, applies a protocol and verifies existing user subscriptions", async (t) => {
  const f = await fixture(t);
  const userResponse = await f.api("/api/users", "POST", { name: "Allowed", email: "allowed@example.com", quotaGb: 100, nodeScope: ["all"], expiresAt: "2099-01-01", portalStatus: "active", state: "active" });
  assert.equal(userResponse.status, 201);
  const user = await userResponse.json();
  const subscriptionBefore = await (await f.api(`/api/users/${user.id}/subscription/rotate`, "POST", {})).json();
  const scoped = await (await f.api("/api/users", "POST", { name: "Scoped elsewhere", email: "scoped@example.com", quotaGb: 100, nodeScope: ["us"], expiresAt: "2099-01-01", portalStatus: "active", state: "active" })).json();
  const scopedSubscription = await (await f.api(`/api/users/${scoped.id}/subscription/rotate`, "POST", {})).json();
  const response = await f.start();
  assert.equal(response.status, 202);
  const { job } = await response.json();
  const result = await f.finish(job.id);
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.result.subscriptionVerified, true);
  assert.equal(result.result.verifiedUserCount, 1);
  assert.equal(result.result.usageMeteringStatus, "healthy");
  assert.deepEqual(result.result.protocols, ["shadowsocks"]);
  const host = f.app.store.getHost(result.hostId);
  assert.equal(host.appliedProtocols.find((p) => p.type === "shadowsocks").enabled, true);
  assert.equal(host.appliedProtocols.find((p) => p.type === "shadowsocks").port, 443);
  assert.equal(host.appliedProtocols.find((p) => p.type === "shadowsocks").listen, "0.0.0.0", "IPv4-only VPS must not require an IPv6 listener");
  const replay = await (await f.start()).json();
  assert.equal(replay.job.id, result.id);
  assert.equal(f.installations.length, 1);
  const subscriptionAfter = await (await f.api(`/api/users/${user.id}/subscription`)).json();
  assert.equal(subscriptionAfter.subscriptionUrl, subscriptionBefore.subscriptionUrl);
  for (const format of ["sing-box", "mihomo", "loon", "egern", "egern-profile"]) {
    const url = new URL(subscriptionAfter.subscriptionUrl);
    const response = await fetch(`${f.base}${url.pathname}?format=${format}`);
    assert.equal(response.status, 200, format);
    assert.ok((await response.text()).includes("203.0.113.42"), `${format} contains new node`);
  }
  const scopedResponse = await fetch(`${f.base}${new URL(scopedSubscription.subscriptionUrl).pathname}?format=singbox`);
  assert.ok([200, 403].includes(scopedResponse.status));
  assert.ok(!(await scopedResponse.text()).includes("203.0.113.42"));
  const applied = JSON.parse(f.publications.at(-1).configText);
  const runtimeUsers = applied.inbounds.find((entry) => entry.type === "shadowsocks").users;
  assert.ok(runtimeUsers.some((entry) => entry.name === "allowed@example.com"));
  assert.ok(!runtimeUsers.some((entry) => entry.name === "scoped@example.com"));
  const listing = await (await f.api("/api/hosts/provision")).json();
  assert.doesNotMatch(JSON.stringify(listing), /ssh-secret-only-memory|enrollmentToken|nodeSecret/);
  const db = await readFile(join(f.dataDir, "raylink.db"));
  assert.equal(db.includes(Buffer.from("ssh-secret-only-memory")), false);
});

test("SSH failures are safe, create no Host and can be explicitly retried", async (t) => {
  const f = await fixture(t);
  const { job } = await (await f.start({ password: "wrong" })).json();
  const failed = await f.finish(job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "SSH_AUTH_FAILED");
  assert.doesNotMatch(JSON.stringify(failed), /MUST NOT LEAK/);
  assert.equal(f.app.store.listHosts().length, 1);
  const retry = await f.api(`/api/hosts/provision/${job.id}/retry`, "POST", { requestId: "retry-1", password: "ssh-secret-only-memory" });
  assert.equal(retry.status, 202);
  const result = await f.finish(job.id);
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.result.subscriptionStatus, "awaiting-users");
  assert.equal(result.result.subscriptionVerified, false);
});

test("a failed public protocol probe stays failed and resumes the same enrolled Host without SSH credentials", async (t) => {
  let reachable = false;
  const f = await fixture(t, { buildTags: ["with_v2ray_api", "with_acme"], nodeDomainLookup: async () => [{ address: "203.0.113.42" }],
    protocolProbe: async () => ({ reachable, latencyMs: 12, probe: "sing-box-tools-fetch" }) });
  await f.api("/api/settings/certificate", "PATCH", { email: "ops@example.com" });
  f.app.store.updateHostProtocolConfig("local", "vless", { enabled: true, port: 48444,
    tls: { mode: "certificate", serverName: "main.example.com", certificatePath: "/cert", keyPath: "/key" },
    transport: { type: "ws", path: "/retain-node-transport" } });
  const { job } = await (await f.start({ domainMode: "existing", endpointDomain: "retry.example.com", inheritProtocols: true })).json();
  const failed = await f.finish(job.id);
  assert.equal(failed.errorCode, "PROVISIONING_CONNECTIVITY");
  assert.equal(failed.status, "failed");
  const nodeProfiles = f.app.store.listHostProtocolConfigs(failed.hostId);
  f.app.store.updateHostProtocolConfig("local", "vless", { port: 49444, transport: { type: "ws", path: "/changed-main-template" } });
  reachable = true;
  const retried = await f.api(`/api/hosts/provision/${job.id}/retry`, "POST", { requestId: "retry-public-1" });
  assert.equal(retried.status, 202);
  const completed = await f.finish(job.id);
  assert.equal(completed.status, "succeeded", JSON.stringify(completed));
  assert.equal(completed.hostId, failed.hostId);
  assert.deepEqual(f.app.store.listHostProtocolConfigs(completed.hostId), nodeProfiles, "retry must not replace already-configured node protocols with a changed main-host template");
  assert.deepEqual(completed.result.protocols, ["shadowsocks", "vless"]);
  assert.equal(f.installations.length, 1);
  assert.equal(f.app.store.listHosts().length, 2);
  const replay = await f.api(`/api/hosts/provision/${job.id}/retry`, "POST", { requestId: "retry-public-1" });
  assert.equal((await replay.json()).job.status, "succeeded");
  assert.equal(f.installations.length, 1);
});

test("an occupied default port automatically publishes an available replacement without changing the Host", async (t) => {
  const f = await fixture(t, { nodePublish: async (_payload, attempt) => {
    if (attempt === 1) throw Object.assign(new Error("occupied"), { code: "PROTOCOL_PORT_OCCUPIED", suggestedPort: 1443, rolledBack: true });
  } });
  const { job } = await (await f.start()).json();
  const completed = await f.finish(job.id);
  assert.equal(completed.status, "succeeded", JSON.stringify(completed));
  assert.equal(f.publications.length, 2);
  assert.equal(f.publications[0].activation.port, 443);
  assert.equal(f.publications[1].activation.port, 1443);
  assert.equal(f.app.store.getHost(completed.hostId).appliedProtocols.find((profile) => profile.type === "shadowsocks").port, 1443);
});

test("IPv6 SSH onboarding stores a usable bare IPv6 endpoint and applies its protocol", async (t) => {
  const f = await fixture(t);
  const { job } = await (await f.start({ host: "[2001:db8::42]" })).json();
  const completed = await f.finish(job.id);
  assert.equal(completed.status, "succeeded", JSON.stringify(completed));
  assert.equal(f.app.store.getHost(completed.hostId).address, "2001:db8::42");
  assert.equal(f.publications.at(-1).activation.address, "2001:db8::42");
});

test("HTTP MCP requires explicit SSH scope and completes onboarding through the shared job workflow", async (t) => {
  const f = await fixture(t);
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const connect = async (scopes) => {
    const token = await (await f.api("/api/mcp/tokens", "POST", { name: "SSH agent", scopes })).json();
    const client = new Client({ name: "onboarding-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token.token}`, host: "panel.example.com" } } }));
    t.after(() => client.close());
    return client;
  };
  const limited = await connect(["read", "runtime.manage"]);
  assert.ok(!(await limited.listTools()).tools.some((entry) => entry.name === "hosts_provision_start"));
  const agent = await connect(["read", "runtime.manage", "hosts.provision"]);
  const input = { name: "hosts_provision_start", arguments: { requestId: "agent-start-1", host: "203.0.113.42", username: "root", password: "ssh-secret-only-memory" } };
  const started = await agent.callTool(input);
  assert.ok(!started.isError, JSON.stringify(started));
  const job = started.structuredContent.job;
  await f.finish(job.id);
  const status = await agent.callTool({ name: "hosts_provision_get", arguments: { jobId: job.id } });
  assert.equal(status.structuredContent.job.status, "succeeded");
  assert.equal(status.structuredContent.job.result.subscriptionStatus, "awaiting-users");
  const replay = await agent.callTool(input);
  assert.equal(replay.structuredContent.job.id, job.id);
  assert.equal(f.installations.length, 1);
});

test("automatic node domain inherits main-host public protocols with independent shared ACME and five subscriptions", async (t) => {
  const records = [], dnsWrites = [];
  const f = await fixture(t, {
    buildTags: ["with_v2ray_api", "with_acme", "with_quic"], nodeDomainPollMs: 1, nodeDomainWaitMs: 30,
    nodeDomainLookup: async () => [{ address: "203.0.113.42" }],
    nodeDomainFetch: async (url, init) => {
      if (!url.includes("/dns_records")) return Response.json({ success: true, result: { name: "example.com" } });
      if (init.method === "POST") { records.push({ id: "cf-one", ...JSON.parse(init.body) }); dnsWrites.push(init.body); }
      return Response.json({ success: true, result: init.method === "POST" ? records[0] : records });
    }
  });
  const user = await (await f.api("/api/users", "POST", { name: "Domain user", email: "domain@example.com", quotaGb: 100, nodeScope: ["all"], expiresAt: "2099-01-01", portalStatus: "active", state: "active" })).json();
  const subscription = await (await f.api(`/api/users/${user.id}/subscription/rotate`, "POST", {})).json();
  await f.api("/api/settings/certificate", "PATCH", { email: "ops@example.com" });
  const settings = await f.api("/api/settings/node-domains", "PATCH", { provider: "cloudflare", zoneId: "a".repeat(32), baseDomain: "nodes.example.com", apiToken: "CF-private-fixture", autoProvision: true, inheritProtocols: true });
  assert.equal(settings.status, 200);
  const inherited = [["vmess", 8442], ["vless", 8443], ["trojan", 9443], ["anytls", 8445], ["hysteria", 8446], ["tuic", 8447], ["hysteria2", 8448]];
  for (const [type, port] of inherited) {
    f.app.store.updateHostProtocolConfig("local", type, { enabled: true, port,
      tls: { mode: "certificate", serverName: "main.example.com", certificatePath: "/main-only/fullchain.pem", keyPath: "/main-only/private.key" },
      ...(type === "vless" ? { transport: { type: "ws", path: "/access" } } : {}) });
  }
  const { job } = await (await f.start({ domainMode: "auto", inheritProtocols: true })).json();
  const finished = await f.finish(job.id);
  assert.equal(finished.status, "succeeded", JSON.stringify(finished));
  assert.deepEqual([...finished.result.protocols].sort(), ["shadowsocks", ...inherited.map(([type]) => type)].sort());
  assert.equal(finished.result.subscriptionStatus, "verified");
  assert.equal(finished.result.protocolChecks.length, 8);
  const host = f.app.store.getHost(finished.hostId);
  assert.equal(host.address, "203.0.113.42");
  assert.match(host.endpointDomain, /^node-.*\.nodes\.example\.com$/);
  assert.equal(dnsWrites.length, 1);
  assert.equal(records[0].proxied, false);
  const config = JSON.parse(f.publications.at(-1).configText);
  assert.equal(config.certificate_providers.length, 1);
  assert.equal(config.certificate_providers[0].disable_tls_alpn_challenge, true);
  assert.deepEqual(config.certificate_providers[0].domain, [host.endpointDomain]);
  assert.doesNotMatch(f.publications.at(-1).configText, /main-only|main\.example|CF-private-fixture/);
  assert.equal(config.inbounds.find((entry) => entry.type === "vless").transport.path, "/access");
  for (const [type] of inherited) {
    const activation = f.publications.find(payload => payload.activation?.type === type)?.activation;
    assert.equal(activation?.network, ["hysteria", "tuic", "hysteria2"].includes(type) ? "udp" : "tcp");
    assert.equal(activation?.exposure, "public");
    assert.ok(activation.challengePorts.some(rule => rule.port === 80 && rule.network === "tcp"));
    assert.ok(host.appliedProtocols.some(profile => profile.type === type && profile.enabled));
  }
  for (const format of ["sing-box", "mihomo", "loon", "egern", "egern-profile"]) {
    const response = await fetch(`${f.base}${new URL(subscription.subscriptionUrl).pathname}?format=${format}`);
    assert.equal(response.status, 200, format);
    const body = await response.text();
    assert.ok(body.includes(host.endpointDomain), `${format}: preserves endpoint domain or TLS server_name`);
    assert.doesNotMatch(body, /main-only|CF-private-fixture/);
  }
  assert.equal((await (await f.api(`/api/users/${user.id}/subscription`)).json()).subscriptionUrl, subscription.subscriptionUrl);
});

test("DNS propagation failure keeps Shadowsocks working and resumes the same node without SSH credentials", async (t) => {
  let resolved = false;
  const f = await fixture(t, { nodeDomainPollMs: 1, nodeDomainWaitMs: 20,
    nodeDomainLookup: async () => [{ address: resolved ? "203.0.113.42" : "203.0.113.99" }] });
  const { job } = await (await f.start({ domainMode: "existing", endpointDomain: "retry.example.com", inheritProtocols: false })).json();
  const failed = await f.finish(job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "NODE_DOMAIN_DNS_PENDING");
  const before = f.app.store.getHost(failed.hostId);
  assert.ok(before.appliedProtocols.some((profile) => profile.type === "shadowsocks" && profile.enabled));
  assert.equal(before.endpointDomain, null);
  resolved = true;
  const retry = await f.api(`/api/hosts/provision/${job.id}/retry`, "POST", { requestId: "dns-fixed" });
  assert.equal(retry.status, 202);
  const finished = await f.finish(job.id);
  assert.equal(finished.status, "succeeded", JSON.stringify(finished));
  assert.equal(finished.hostId, failed.hostId);
  assert.equal(finished.result.endpointDomain, "retry.example.com");
  assert.equal(f.installations.length, 1);
  assert.equal(f.app.store.getHost(failed.hostId).address, "203.0.113.42");
});

test("IP-only provisioning reports skipped domain protocols and retains the default usable Shadowsocks", async (t) => {
  const f = await fixture(t);
  f.app.store.updateHostProtocolConfig("local", "vless", { enabled: true, tls: { mode: "certificate", serverName: "main.example.com", certificatePath: "/cert", keyPath: "/key" } });
  const { job } = await (await f.start({ domainMode: "none", inheritProtocols: true })).json();
  const finished = await f.finish(job.id);
  assert.equal(finished.status, "succeeded", JSON.stringify(finished));
  assert.deepEqual(finished.result.protocols, ["shadowsocks"]);
  assert.deepEqual(finished.result.skippedProtocols, [{ type: "vless", reason: "DOMAIN_REQUIRED" }]);
});
