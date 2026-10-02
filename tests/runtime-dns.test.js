import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RayLinkStore } from "../server/database.js";
import { buildSingBoxConfig } from "../server/singbox/config.js";
import { RuntimeManager } from "../server/singbox/runtime-manager.js";

function configuration(runtimeVersion = "1.14.2", runtimeDns, kind = "local") {
  return buildSingBoxConfig({ host: { kind, runtimeVersion }, protocols: [], users: [], masterPassword: "fixture" }, { runtimeDns });
}

test("Runtime DNS uses independent verified DoH services for local and remote Hosts without overriding system DNS", () => {
  for (const kind of ["local", "remote"]) {
    const config = configuration("1.14.2", undefined, kind);
    const publicServers = config.dns.servers.filter(server => server.type === "https");
    assert.deepEqual(publicServers.map(server => [server.server, server.tls.server_name]), [
      ["1.1.1.1", "cloudflare-dns.com"], ["9.9.9.9", "dns.quad9.net"]
    ]);
    assert.ok(publicServers.every(server => server.tls.enabled && !server.tls.insecure));
    assert.equal(config.dns.cache_capacity, 4096);
    assert.ok(config.route.rules.some(rule => rule.action === "resolve"), "direct requests must pass through DNS rules and their fallback");
    assert.equal(config.route.final, "direct");
    assert.ok(config.dns.rules.some(rule => rule.server === "runtime-local" && rule.domain_suffix?.includes("home.arpa")));
  }
});

test("administrators can keep system DNS for split DNS deployments or supply a verified enterprise resolver and private zones", () => {
  const system = configuration("1.14.2", { mode: "system" });
  assert.equal(system.dns, undefined);
  assert.deepEqual(system.route, { final: "direct" });
  const custom = configuration("1.14.2", { primary: "192.0.2.53", primaryServerName: "resolver.example.com",
    secondary: "2001:db8::53", secondaryServerName: "backup.example.com", privateSuffixes: [".Corp.Example."] });
  assert.equal(custom.dns.servers[1].server, "192.0.2.53");
  assert.equal(custom.dns.servers[1].tls.server_name, "resolver.example.com");
  assert.equal(custom.dns.servers[2].server, "2001:db8::53");
  assert.ok(custom.dns.rules.some(rule => rule.server === "runtime-local" && rule.domain_suffix?.includes("corp.example")));
});

test("Runtime DNS rejects overrides that would silently change mode, loop DNS bootstrapping or accept malformed private names", () => {
  for (const input of [{ mode: "typo" }, { primary: "resolver.example.com" }, { primaryServerName: "*bad-name" },
    { privateSuffixes: "corp.example" }, { privateSuffixes: ["*.corp.example"] }, { privateSuffixes: [123] }]) {
    assert.throws(() => configuration("1.14.2", input), { code: "INVALID_RUNTIME_DNS", statusCode: 422 });
  }
});

test("older supported Runtimes do not receive the 1.14-only DNS query timeout", () => {
  assert.equal(configuration("1.13.14").dns.timeout, undefined);
  assert.equal(configuration("1.14.2").dns.timeout, "2s");
});

test("RuntimeManager carries administrator DNS choices into preview, publication and every remote Host task", async t => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-runtime-dns-publication-"));
  const store = new RayLinkStore({ dbPath: join(directory, "store.db"), seedDemoData: false,
    adminUsername: "admin", adminPassword: "dns-publication-fixture" });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const { host, enrollmentToken } = store.createRemoteHost({ name: "DNS Host", address: "192.0.2.8", region: "test" });
  store.enrollNode(enrollmentToken, { agentVersion: "0.9.1", runtimeVersion: "1.14.2" });
  const publications = [];
  const adapter = { publish: async publication => { publications.push(publication); return { mode: "test" }; } };
  for (const runtimeDns of [{ mode: "auto", primary: "192.0.2.53", primaryServerName: "dns.example", privateSuffixes: ["corp.example"] },
    { mode: "system" }]) {
    const manager = new RuntimeManager({ store, adapter, runtimeDns });
    const verify = config => {
      if (runtimeDns.mode === "system") assert.equal(config.dns, undefined);
      else {
        assert.equal(config.dns.servers.find(server => server.tag === "runtime-primary").server, "192.0.2.53");
        assert.ok(config.dns.rules.some(rule => rule.server === "runtime-local" && rule.domain_suffix?.includes("corp.example")));
      }
    };
    for (const hostId of ["local", host.id]) verify(manager.compileHostRuntimeConfig(hostId));
    const preview = manager.preview();
    const candidate = await manager.prepareDeploymentCandidate();
    assert.equal(candidate.compiled.checksum, preview.checksum);
    verify(candidate.compiled.config);
    assert.equal(candidate.remoteDeployments.length, 1);
    verify(candidate.remoteDeployments[0].remote.config);
    const deployment = await manager.publish();
    assert.equal(deployment.status, "active");
    verify(JSON.parse(publications.at(-1).configText));
    const task = store.nextNodeTask(host.id);
    assert.equal(task.kind, "publish-config");
    verify(JSON.parse(task.payload.configText));
    store.completeNodeTask(host.id, task.id, { attempt: task.attempt, status: "succeeded" });
  }
});
