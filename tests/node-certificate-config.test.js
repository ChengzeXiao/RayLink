import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildSingBoxConfig } from "../server/singbox/config.js";
import { defaultProtocolConfigs, buildMultiHostProtocolClientConfig } from "../server/singbox/protocol-catalog.js";
import { NodeRuntimeAdapter } from "../web/node/raylink-node.mjs";

function profiles() {
  return defaultProtocolConfigs().filter((profile) => ["trojan", "hysteria2"].includes(profile.type)).map((profile) => ({
    ...profile, enabled: true, tls: { ...profile.tls, mode: "acme", serverName: "node.example.com", acmeEmail: "ops@example.com" }
  }));
}
function snapshot(kind = "remote", runtimeVersion = "1.14.2") {
  return { host: { kind, region: "global", runtimeVersion }, users: [], protocols: profiles(), masterPassword: "AAAAAAAAAAAAAAAAAAAAAA==" };
}

test("remote 1.14 TLS protocols share one HTTP-01 certificate provider in the Node writable directory", () => {
  const config = buildSingBoxConfig(snapshot());
  assert.equal(config.certificate_providers?.length, 1);
  const provider = config.certificate_providers[0];
  assert.deepEqual(provider.domain, ["node.example.com"]);
  assert.equal(provider.data_directory, "/var/lib/raylink-node/sing-box/acme");
  assert.equal(provider.disable_tls_alpn_challenge, true);
  assert.deepEqual(config.inbounds.map((inbound) => inbound.tls.certificate_provider), [provider.tag, provider.tag]);
});

test("legacy remote ACME stays inline while local certificate storage remains compatible", () => {
  const legacy = buildSingBoxConfig(snapshot("remote", "1.13.14"));
  assert.equal(legacy.certificate_providers, undefined);
  assert.equal(legacy.inbounds[0].tls.acme.data_directory, "/var/lib/raylink-node/sing-box/acme");
  assert.equal(legacy.inbounds[0].tls.acme.disable_tls_alpn_challenge, true);
  const local = buildSingBoxConfig(snapshot("local"));
  assert.equal(local.certificate_providers[0].data_directory, "/var/lib/raylink/acme");
});

test("HTTP-01 reserves TCP80 against managed protocol listeners before deployment", () => {
  const input = snapshot();
  input.protocols.push({ ...defaultProtocolConfigs().find((profile) => profile.type === "shadowsocks"), enabled: true, port: 80 });
  assert.throws(() => buildSingBoxConfig(input), (error) => error.code === "ACME_CHALLENGE_PORT_OCCUPIED");
});

test("client configurations use the endpoint domain while retaining IP fallback for Hosts without one", () => {
  const config = buildMultiHostProtocolClientConfig({
    credential: { email: "client@example.com", runtimePassword: "AAAAAAAAAAAAAAAAAAAAAA==", uuid: "11111111-1111-4111-8111-111111111111" },
    hosts: [
      { id: "domain", address: "203.0.113.42", endpointDomain: "node.example.com", protocols: profiles() },
      { id: "ip", address: "203.0.113.43", protocols: profiles() }
    ]
  });
  assert.equal(config.outbounds.find((outbound) => outbound.tag === "raylink-domain-trojan").server, "node.example.com");
  assert.equal(config.outbounds.find((outbound) => outbound.tag === "raylink-ip-trojan").server, "203.0.113.43");
});

test("Node resolves ACME storage to its custom data directory before validating and saving config", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-acme-custom-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let validated;
  const adapter = new NodeRuntimeAdapter({ dataDir: directory, runtimeMode: "dry-run",
    commandRunner: async (_command, args) => {
      if (args[0] === "check") validated = JSON.parse(await readFile(args[2], "utf8"));
      return { stdout: "sing-box version 1.14.2" };
    }, portVerifier: { async assertAvailable() {} }
  });
  const result = await adapter.publish({ configText: JSON.stringify(buildSingBoxConfig(snapshot())), checksum: "source-snapshot" });
  const saved = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
  assert.equal(saved.certificate_providers[0].data_directory, join(directory, "acme"));
  assert.deepEqual(saved, validated);
  assert.equal(result.checksum, "source-snapshot");
  assert.equal(result.appliedChecksum, createHash("sha256").update(await readFile(join(directory, "config.json"))).digest("hex"));
});

test("native sing-box validates shared ACME providers after Node storage adaptation", { skip: !process.env.SING_BOX_BIN }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-acme-native-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const adapter = new NodeRuntimeAdapter({ dataDir: directory, runtimeMode: "dry-run", binaryPath: process.env.SING_BOX_BIN,
    commandRunner: promisify(execFile), portVerifier: { async assertAvailable() {} }
  });
  const result = await adapter.publish({ configText: JSON.stringify(buildSingBoxConfig(snapshot())) });
  assert.equal(result.runtimeVersion, "1.14.2");
  const saved = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
  assert.equal(saved.certificate_providers.length, 1);
  assert.equal(saved.inbounds.length, 2);
});

test("Node refuses an occupied ACME challenge port before replacing its config or restarting services", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-acme-port-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checked = [], commands = [];
  const adapter = new NodeRuntimeAdapter({ dataDir: directory, runtimeMode: "dry-run",
    commandRunner: async (command, args) => { commands.push([command, args]); return { stdout: "sing-box version 1.14.2" }; },
    portVerifier: { async assertAvailable(input) { checked.push(input.port); if (input.port === 80) throw Object.assign(new Error("port occupied"), { code: "PROTOCOL_PORT_OCCUPIED", suggestedPort: 81 }); }, async waitForListening() {} },
    firewallManager: { async open() { return { rollback: async () => {} }; } },
    protocolProbe: { async verify() { return { reachable: true }; } }
  });
  await assert.rejects(adapter.publish({ configText: JSON.stringify(buildSingBoxConfig(snapshot())), activation: {
    type: "trojan", port: 8443, network: "tcp", exposure: "public", challengePorts: [{ port: 80, network: "tcp", purpose: "acme-http-01" }]
  } }), (error) => error.code === "ACME_CHALLENGE_PORT_OCCUPIED" && error.suggestedPort === undefined);
  assert.deepEqual(checked, [8443, 80]);
  assert.deepEqual(commands, []);
  await assert.rejects(readFile(join(directory, "config.json")), { code: "ENOENT" });
});
