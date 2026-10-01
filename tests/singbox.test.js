import assert from "node:assert/strict";
import test from "node:test";

import { defaultProtocolConfigs } from "../server/singbox/protocol-catalog.js";

import { buildSingBoxConfig } from "../server/singbox/config.js";

test("sing-box config contains one credential per eligible user", () => {
  const config = buildSingBoxConfig({
    host: { id: "local", region: "tokyo" },
    masterPassword: "MDEyMzQ1Njc4OWFiY2RlZg==",
    users: [
      {
        email: "active@example.cn",
        state: "active",
        portalStatus: "active",
        usedGb: 1,
        quotaGb: 10,
        expiresAt: "2027-01-31",
        runtimePassword: "YWJjZGVmZ2hpamtsbW5vcA==",
        nodeScope: ["tokyo"]
      },
      {
        email: "all-nodes@example.cn",
        state: "warning",
        portalStatus: "active",
        usedGb: 9,
        quotaGb: 10,
        expiresAt: "2027-02-28",
        runtimePassword: "cXdlcnR5dWlvcGFzZGZnaA==",
        nodeScope: ["all"]
      },
      {
        email: "disabled@example.cn",
        state: "disabled",
        portalStatus: "active",
        usedGb: 1,
        quotaGb: 10,
        expiresAt: "2027-02-28",
        runtimePassword: "emFzZGZnaGprbHF3ZXJ0eQ==",
        nodeScope: ["tokyo"]
      },
      {
        email: "expired@example.cn",
        state: "active",
        portalStatus: "active",
        usedGb: 1,
        quotaGb: 10,
        expiresAt: "2025-01-01",
        runtimePassword: "eHVpY2h1c2h1aWJhaWppYQ==",
        nodeScope: ["tokyo"]
      },
      {
        email: "over-quota@example.cn",
        state: "active",
        portalStatus: "active",
        usedGb: 10,
        quotaGb: 10,
        expiresAt: "2027-02-28",
        runtimePassword: "eHVpY2h1c2h1aWJhaWppYQ==",
        nodeScope: ["tokyo"]
      },
      {
        email: "revoked@example.cn",
        state: "active",
        portalStatus: "invited",
        usedGb: 1,
        quotaGb: 10,
        expiresAt: "2027-02-28",
        runtimePassword: "eHVpY2h1c2h1aWJhaWppYQ==",
        nodeScope: ["tokyo"]
      }
    ]
  }, {
    now: new Date("2026-07-26T00:00:00.000Z"),
    listenPort: 8388
  });

  assert.deepEqual(config.inbounds, [{
    type: "shadowsocks",
    tag: "managed-shadowsocks",
    listen: "::",
    listen_port: 8388,
    network: "tcp",
    method: "2022-blake3-aes-128-gcm",
    password: "MDEyMzQ1Njc4OWFiY2RlZg==",
    users: [
      { name: "active@example.cn", password: "YWJjZGVmZ2hpamtsbW5vcA==" },
      { name: "all-nodes@example.cn", password: "cXdlcnR5dWlvcGFzZGZnaA==" },
      { name: "raylink-probe@internal", password: "RU9hpUIXViwOQSsacCx2Wg==" }
    ]
  }]);
  assert.equal(config.outbounds[0].type, "direct");
});

test("metering-capable Runtime enables loopback V2Ray Stats for eligible users only", () => {
  const config = buildSingBoxConfig({
    host: {
      id: "remote-1",
      region: "tokyo",
      buildTags: ["with_quic", "with_v2ray_api"]
    },
    masterPassword: "MDEyMzQ1Njc4OWFiY2RlZg==",
    users: [{
      email: "metered@example.com",
      state: "active",
      portalStatus: "active",
      usedGb: 0,
      quotaGb: 10,
      expiresAt: "2027-01-31",
      runtimePassword: "YWJjZGVmZ2hpamtsbW5vcA==",
      nodeScope: ["all"]
    }]
  }, { now: new Date("2026-07-26T00:00:00.000Z") });

  assert.deepEqual(config.experimental.v2ray_api, {
    listen: "127.0.0.1:10085",
    stats: {
      enabled: true,
      users: ["metered@example.com"]
    }
  });
});


test("rolling deployments select ACME syntax using the Host Runtime version", () => {
  const profile = {
    ...defaultProtocolConfigs().find((item) => item.type === "hysteria2"),
    enabled: true,
    tls: { mode: "acme", serverName: "node.example.com", acmeEmail: "ops@example.com",
      acmeDataDirectory: "/var/lib/raylink/acme" }
  };
  for (const runtimeVersion of [undefined, "1.13.14", "1.14.2"]) {
    const config = buildSingBoxConfig({
      host: { region: "test", runtimeVersion }, users: [], protocols: [profile],
      masterPassword: "AAAAAAAAAAAAAAAAAAAAAA=="
    });
    const tls = config.inbounds[0].tls;
    const provider = runtimeVersion === "1.14.2" ? config.certificate_providers.find((entry) => entry.tag === tls.certificate_provider) : tls.acme;
    assert.deepEqual(provider.domain, ["node.example.com"]);
    assert.equal(provider.data_directory, "/var/lib/raylink/acme");
    assert.equal(provider.type, runtimeVersion === "1.14.2" ? "acme" : undefined);
    assert.equal(runtimeVersion === "1.14.2" ? tls.acme : tls.certificate_provider, undefined);
  }
});
