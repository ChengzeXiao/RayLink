import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMultiHostProtocolClientConfig,
  buildProtocolClientConfig,
  buildProtocolInbounds,
  defaultProtocolConfigs,
  normalizeProtocolConfig,
  protocolAvailability,
  protocolCatalog
} from "../server/singbox/protocol-catalog.js";
import { createRoutePolicyCandidates } from "../server/routing/policy.js";

const eligibleUsers = [
  {
    email: "user@example.com",
    runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d",
    runtimePassword: "dXNlci1wYXNzd29yZA=="
  }
];

test("QUIC transports remain UDP candidates even when their protocol is VLESS", () => {
  const vless = defaultProtocolConfigs().find((profile) => profile.type === "vless");
  const config = buildMultiHostProtocolClientConfig({
    credential: { ...eligibleUsers[0], serverPassword: "AAAAAAAAAAAAAAAAAAAAAA==" },
    hosts: [
      { id: "quic", address: "quic.example.com", protocols: [{
        ...vless, enabled: true, transport: { type: "quic" },
        tls: { mode: "certificate", serverName: "quic.example.com" }
      }] },
      { id: "tcp", address: "tcp.example.com", protocols: [{ ...vless, enabled: true }] }
    ]
  });
  const members = (tag) => config.outbounds.find((outbound) => outbound.tag === tag).outbounds;
  assert.deepEqual(members("raylink-tcp"), ["raylink-tcp-vless"]);
  assert.deepEqual(members("raylink-udp"), ["raylink-quic-vless"]);
  assert.deepEqual(members("raylink-smart"), ["raylink-tcp-vless"]);
  const policy = createRoutePolicyCandidates({
    names: ["raylink-quic-vless", "raylink-tcp-vless"],
    tcp: members("raylink-tcp"), udp: members("raylink-udp"), smart: members("raylink-smart")
  });
  assert.deepEqual(policy.fallback, ["raylink-tcp-vless", "raylink-quic-vless"]);
});

test("client capabilities match the TCP-only managed Shadowsocks listener", () => {
  const config = buildProtocolClientConfig({
    credential: { ...eligibleUsers[0], serverPassword: "AAAAAAAAAAAAAAAAAAAAAA==" },
    profiles: defaultProtocolConfigs(),
    server: "node.example.com"
  });
  assert.equal(config.outbounds.find((outbound) => outbound.type === "shadowsocks").network, "tcp");
  for (const group of config.outbounds.filter((outbound) => outbound.type === "urltest")) {
    assert.equal(group.interrupt_exist_connections, false);
  }
});

test("source catalog exposes the inbound protocols registered by sing-box 1.13", () => {
  assert.deepEqual(
    protocolCatalog.map((protocol) => protocol.type),
    [
      "shadowsocks",
      "vmess",
      "trojan",
      "naive",
      "shadowtls",
      "vless",
      "anytls",
      "hysteria",
      "tuic",
      "hysteria2",
      "socks",
      "http",
      "mixed",
      "direct",
      "tun",
      "redirect",
      "tproxy"
    ]
  );
});

test("managed protocol profiles compile separate user credentials into server inbounds", () => {
  const profiles = defaultProtocolConfigs(8388).map((profile) => {
    if (profile.type === "shadowsocks") return profile;
    if (profile.type === "vless") {
      return {
        ...profile,
        enabled: true,
        port: 8443,
        tls: { mode: "none" }
      };
    }
    return profile;
  });

  const inbounds = buildProtocolInbounds({
    profiles,
    users: eligibleUsers,
    masterPassword: "c2VydmVyLWtleS0xNg=="
  });

  assert.equal(inbounds.length, 2);
  assert.deepEqual(inbounds[0].users.slice(0, 1), [{
    name: "user@example.com",
    password: "dXNlci1wYXNzd29yZA=="
  }]);
  assert.equal(inbounds[0].users[1].name, "raylink-probe@internal");
  assert.deepEqual(inbounds[1].users.slice(0, 1), [{
    name: "user@example.com",
    uuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d"
  }]);
  assert.equal(inbounds[1].users[1].name, "raylink-probe@internal");
});

test("ACME TLS profiles compile a node-bound certificate request for sing-box 1.13", () => {
  const profile = normalizeProtocolConfig({
    ...defaultProtocolConfigs().find((item) => item.type === "hysteria2"),
    enabled: true,
    tls: {
      mode: "acme",
      serverName: "node.example.com",
      acmeEmail: "ops@example.com"
    }
  });

  const [inbound] = buildProtocolInbounds({
    profiles: [profile],
    users: eligibleUsers,
    masterPassword: "c2VydmVyLWtleS0xNg=="
  });

  assert.deepEqual(inbound.tls, {
    enabled: true,
    server_name: "node.example.com",
    acme: {
      domain: ["node.example.com"],
      default_server_name: "node.example.com",
      email: "ops@example.com",
      data_directory: "/var/lib/raylink/acme"
    }
  });
});

test("public protocol probes have a dedicated credential before the first user is created", () => {
  const profile = normalizeProtocolConfig({
    ...defaultProtocolConfigs().find((item) => item.type === "hysteria2"),
    enabled: true,
    tls: {
      mode: "acme",
      serverName: "node.example.com",
      acmeEmail: "ops@example.com"
    }
  });

  const [inbound] = buildProtocolInbounds({
    profiles: [profile],
    users: [],
    masterPassword: "c2VydmVyLWtleS0xNg=="
  });

  assert.equal(inbound.users.length, 1);
  assert.equal(inbound.users[0].name, "raylink-probe@internal");
  assert.match(inbound.users[0].password, /^[A-Za-z0-9_-]{32}$/);

  const vlessProfile = normalizeProtocolConfig({
    ...defaultProtocolConfigs().find((item) => item.type === "vless"),
    enabled: true,
    tls: {
      mode: "certificate",
      serverName: "node.example.com",
      certificatePath: "/tmp/node.crt",
      keyPath: "/tmp/node.key"
    }
  });
  const [vlessInbound] = buildProtocolInbounds({
    profiles: [vlessProfile],
    users: [],
    masterPassword: "c2VydmVyLWtleS0xNg=="
  });
  assert.equal(vlessInbound.users[0].name, "raylink-probe@internal");
  assert.match(vlessInbound.users[0].uuid, /^[0-9a-f-]{36}$/);
});

test("client configuration includes every enabled user-facing protocol", () => {
  const profiles = defaultProtocolConfigs(8388).map((profile) => {
    if (profile.type === "vless") {
      return {
        ...profile,
        enabled: true,
        port: 8443,
        tls: { mode: "none" }
      };
    }
    return profile;
  });
  const config = buildProtocolClientConfig({
    profiles,
    credential: {
      email: eligibleUsers[0].email,
      runtimeUuid: eligibleUsers[0].runtimeUuid,
      runtimePassword: eligibleUsers[0].runtimePassword,
      serverPassword: "c2VydmVyLWtleS0xNg=="
    },
    server: "node.example.com"
  });

  assert.deepEqual(config.outbounds.slice(0, 2).map((outbound) => outbound.type), ["shadowsocks", "vless"]);
  assert.equal(config.route.final, "raylink-auto");
  assert.deepEqual(
    config.outbounds.find((outbound) => outbound.type === "selector").outbounds,
    [
      "raylink-smart",
      "raylink-tcp",
      "raylink-fastest",
      "raylink-shadowsocks",
      "raylink-vless"
    ]
  );
  assert.equal(
    config.outbounds.find((outbound) => outbound.type === "selector").default,
    "raylink-smart"
  );
  assert.deepEqual(config.inbounds.map((inbound) => inbound.type), ["tun", "mixed"]);
  assert.equal(config.inbounds[0].auto_route, true);
  assert.equal(config.inbounds[0].strict_route, true);
  assert.deepEqual(config.dns.servers.map((server) => server.tag), ["dns-local", "dns-remote"]);
  assert.deepEqual(config.dns.servers[0], {
    type: "local",
    tag: "dns-local"
  });
  assert.equal(config.dns.final, "dns-remote");
  assert.equal(config.route.rules[0].action, "sniff");
  assert.equal(config.route.rules[1].action, "hijack-dns");
  assert.equal(
    config.outbounds.find((outbound) => outbound.tag === "raylink-ai").default,
    "raylink-auto"
  );
  assert.deepEqual(
    config.route.rules.find((rule) => rule.outbound === "raylink-ai").domain_suffix.slice(0, 2),
    ["openai.com", "chatgpt.com"]
  );
  assert.deepEqual(
    config.route.rule_set.map((ruleSet) => ruleSet.tag),
    ["geosite-geolocation-cn", "geoip-cn"]
  );
  assert.ok(config.route.rule_set.every((ruleSet) => ruleSet.type === "inline"));
  assert.ok(config.route.rule_set.every((ruleSet) => !Object.hasOwn(ruleSet, "url")));
  assert.equal(config.experimental.cache_file.enabled, true);
});

test("sing-box client configuration compiles custom routing and DNS before managed rules", () => {
  const config = buildProtocolClientConfig({
    profiles: defaultProtocolConfigs(),
    credential: {
      email: eligibleUsers[0].email,
      runtimeUuid: eligibleUsers[0].runtimeUuid,
      runtimePassword: eligibleUsers[0].runtimePassword,
      serverPassword: "c2VydmVyLWtleS0xNg=="
    },
    server: "node.example.com",
    routePolicy: {
      mode: "smart",
      rules: [
        {
          match: "domain_suffix",
          value: "work.example",
          action: "direct",
          dns: "domestic",
          priority: 10
        },
        {
          match: "ip_cidr",
          value: "192.0.2.0/24",
          action: "block",
          priority: 20
        }
      ]
    }
  });

  const customDirectIndex = config.route.rules.findIndex(
    (rule) => rule.domain_suffix?.includes("work.example")
  );
  const aiIndex = config.route.rules.findIndex((rule) => rule.outbound === "raylink-ai");
  assert.ok(customDirectIndex > 1);
  assert.ok(customDirectIndex < aiIndex);
  assert.equal(config.route.rules[customDirectIndex].outbound, "direct");
  assert.ok(config.route.rules.some(
    (rule) => rule.ip_cidr?.includes("192.0.2.0/24") && rule.action === "reject"
  ));
  assert.ok(config.dns.rules.some(
    (rule) => rule.domain_suffix?.includes("work.example") && rule.server === "dns-local"
  ));
});

test("all sing-box route policy probes inherit the configured RayLink probe URL", () => {
  const probeUrl = "https://probe.example.com/generate_204";
  const config = buildProtocolClientConfig({
    profiles: defaultProtocolConfigs(),
    credential: {
      email: eligibleUsers[0].email,
      runtimeUuid: eligibleUsers[0].runtimeUuid,
      runtimePassword: eligibleUsers[0].runtimePassword,
      serverPassword: "c2VydmVyLWtleS0xNg=="
    },
    server: "node.example.com",
    probeUrl
  });

  const policyProbes = config.outbounds.filter((outbound) => outbound.type === "urltest");
  assert.ok(policyProbes.length > 0);
  assert.ok(policyProbes.every((outbound) => outbound.url === probeUrl));
});

test("loopback-only proxy inbounds are never published in a remote user subscription", () => {
  const profiles = defaultProtocolConfigs().map((profile) => ({
    ...profile,
    enabled: ["shadowsocks", "socks", "http", "mixed"].includes(profile.type),
    listen: ["socks", "http", "mixed"].includes(profile.type) ? "127.0.0.1" : profile.listen
  }));
  const config = buildProtocolClientConfig({
    profiles,
    credential: {
      email: eligibleUsers[0].email,
      runtimeUuid: eligibleUsers[0].runtimeUuid,
      runtimePassword: eligibleUsers[0].runtimePassword,
      serverPassword: "c2VydmVyLWtleS0xNg=="
    },
    server: "node.example.com"
  });

  assert.deepEqual(
    config.outbounds.filter((outbound) => !["urltest", "selector", "direct"].includes(outbound.type))
      .map((outbound) => outbound.type),
    ["shadowsocks"]
  );
});

test("multi-host client configuration exposes each host's enabled protocols through one selector", () => {
  const tokyoProfiles = defaultProtocolConfigs(8388);
  const frankfurtProfiles = defaultProtocolConfigs(8388).map((profile) => {
    if (profile.type === "shadowsocks") return { ...profile, enabled: false };
    if (profile.type === "vless") {
      return {
        ...profile,
        enabled: true,
        port: 8443,
        tls: { ...profile.tls, mode: "none" }
      };
    }
    return profile;
  });
  const config = buildMultiHostProtocolClientConfig({
    credential: {
      email: eligibleUsers[0].email,
      runtimeUuid: eligibleUsers[0].runtimeUuid,
      runtimePassword: eligibleUsers[0].runtimePassword,
      serverPassword: "c2VydmVyLWtleS0xNg=="
    },
    hosts: [
      {
        id: "local",
        name: "Tokyo",
        address: "tokyo.example.com",
        protocols: tokyoProfiles
      },
      {
        id: "fra-02",
        name: "Frankfurt",
        address: "fra.example.com",
        protocols: frankfurtProfiles
      }
    ]
  });

  assert.deepEqual(
    config.outbounds
      .filter((outbound) => ["shadowsocks", "vless"].includes(outbound.type))
      .map((outbound) => [outbound.type, outbound.server]),
    [
      ["shadowsocks", "tokyo.example.com"],
      ["vless", "fra.example.com"]
    ]
  );
  assert.deepEqual(
    config.outbounds.find((outbound) => outbound.tag === "raylink-auto").outbounds,
    [
      "raylink-smart",
      "raylink-tcp",
      "raylink-fastest",
      "raylink-local-shadowsocks",
      "raylink-fra-02-vless"
    ]
  );
  assert.deepEqual(
    config.outbounds.find((outbound) => outbound.tag === "raylink-fastest").outbounds,
    ["raylink-local-shadowsocks", "raylink-fra-02-vless"]
  );
});

test("client subscription separates TCP and UDP and excludes unhealthy UDP from smart selection", () => {
  const profiles = defaultProtocolConfigs().map((profile) => ({
    ...profile,
    enabled: ["vless", "hysteria2", "tuic"].includes(profile.type),
    tls: ["vless", "hysteria2", "tuic"].includes(profile.type)
      ? { ...profile.tls, mode: "certificate", serverName: "node.example.com" }
      : profile.tls
  }));
  const config = buildMultiHostProtocolClientConfig({
    credential: {
      email: eligibleUsers[0].email,
      runtimeUuid: eligibleUsers[0].runtimeUuid,
      runtimePassword: eligibleUsers[0].runtimePassword,
      serverPassword: "c2VydmVyLWtleS0xNg=="
    },
    hosts: [{
      id: "local",
      name: "California",
      address: "node.example.com",
      protocols: profiles,
      protocolActivations: [
        {
          type: "hysteria2",
          publicCheck: {
            availability: "available",
            reachable: true,
            jitterMs: 18,
            consecutiveFailures: 0,
            samples: { count: 5, successful: 5, failed: 0 },
            healthWindow: {
              successRate: 100,
              rounds: [{}, {}, {}]
            }
          }
        },
        {
          type: "tuic",
          publicCheck: {
            availability: "unavailable",
            reachable: false,
            consecutiveFailures: 3
          }
        }
      ]
    }]
  });

  assert.deepEqual(
    config.outbounds.find((outbound) => outbound.tag === "raylink-tcp").outbounds,
    ["raylink-local-vless"]
  );
  assert.deepEqual(
    config.outbounds.find((outbound) => outbound.tag === "raylink-udp").outbounds,
    ["raylink-local-tuic", "raylink-local-hysteria2"]
  );
  assert.deepEqual(
    config.outbounds.find((outbound) => outbound.tag === "raylink-smart").outbounds,
    ["raylink-local-vless", "raylink-local-hysteria2"]
  );
  const selector = config.outbounds.find((outbound) => outbound.tag === "raylink-auto");
  assert.equal(selector.default, "raylink-smart");
  assert.deepEqual(selector.outbounds.slice(0, 3), [
    "raylink-smart",
    "raylink-tcp",
    "raylink-udp"
  ]);
});

test("UDP groups expose every enabled QUIC protocol and smart selection promotes stable ones", () => {
  const profiles = defaultProtocolConfigs().map((profile) => ({
    ...profile,
    enabled: ["vless", "hysteria", "hysteria2", "tuic"].includes(profile.type),
    tls: ["vless", "hysteria", "hysteria2", "tuic"].includes(profile.type)
      ? { ...profile.tls, mode: "certificate", serverName: "node.example.com" }
      : profile.tls
  }));
  const config = buildMultiHostProtocolClientConfig({
    credential: {
      email: eligibleUsers[0].email,
      runtimeUuid: eligibleUsers[0].runtimeUuid,
      runtimePassword: eligibleUsers[0].runtimePassword,
      serverPassword: "c2VydmVyLWtleS0xNg=="
    },
    hosts: [{
      id: "local",
      name: "California",
      address: "node.example.com",
      protocols: profiles,
      protocolActivations: [
        {
          type: "hysteria",
          publicCheck: {
            availability: "available",
            reachable: true,
            jitterMs: 18,
            consecutiveFailures: 0,
            samples: { count: 5, successful: 5, failed: 0 },
            healthWindow: {
              successRate: 100,
              rounds: [{}, {}, {}]
            }
          }
        },
        {
          type: "hysteria2",
          publicCheck: {
            availability: "available",
            reachable: true,
            jitterMs: 120,
            consecutiveFailures: 0,
            samples: { count: 5, successful: 5, failed: 0 }
          }
        },
        {
          type: "tuic",
          publicCheck: {
            availability: "degraded",
            reachable: true,
            jitterMs: 12,
            consecutiveFailures: 1,
            samples: { count: 5, successful: 0, failed: 5 }
          }
        }
      ]
    }]
  });

  assert.deepEqual(
    config.outbounds.find((outbound) => outbound.tag === "raylink-smart").outbounds,
    ["raylink-local-vless", "raylink-local-hysteria"]
  );
  assert.deepEqual(
    config.outbounds.find((outbound) => outbound.tag === "raylink-udp").outbounds,
    [
      "raylink-local-hysteria",
      "raylink-local-tuic",
      "raylink-local-hysteria2"
    ]
  );
  assert.equal(
    config.outbounds.find((outbound) => outbound.tag === "raylink-auto").default,
    "raylink-smart"
  );
});

test("Hysteria client inherits the managed bandwidth values required by sing-box", () => {
  const profiles = defaultProtocolConfigs().map((profile) => ({
    ...profile,
    enabled: profile.type === "hysteria",
    tls: profile.type === "hysteria"
      ? { ...profile.tls, mode: "certificate", serverName: "node.example.com" }
      : profile.tls,
    options: profile.type === "hysteria"
      ? { up_mbps: 50, down_mbps: 100 }
      : profile.options
  }));
  const config = buildProtocolClientConfig({
    profiles,
    credential: {
      email: eligibleUsers[0].email,
      runtimeUuid: eligibleUsers[0].runtimeUuid,
      runtimePassword: eligibleUsers[0].runtimePassword,
      serverPassword: "c2VydmVyLWtleS0xNg=="
    },
    server: "node.example.com"
  });
  const hysteria = config.outbounds.find((outbound) => outbound.type === "hysteria");

  assert.equal(hysteria.up_mbps, 50);
  assert.equal(hysteria.down_mbps, 100);
});

test("protocol availability is gated by schema version, platform and client build tags", () => {
  const naive = protocolCatalog.find((protocol) => protocol.type === "naive");
  const redirect = protocolCatalog.find((protocol) => protocol.type === "redirect");
  const base = {
    installed: true,
    version: "1.13.12",
    platform: "linux",
    tags: []
  };

  assert.equal(protocolAvailability(naive, base).available, false);
  assert.deepEqual(protocolAvailability(naive, base).missingTags, ["with_naive_outbound"]);
  assert.equal(protocolAvailability(naive, { ...base, version: "1.12.0" }).versionSupported, false);
  assert.equal(protocolAvailability(redirect, { ...base, platform: "win32" }).platformSupported, false);
});

test("transport schema emits service_name for gRPC and no path for QUIC", () => {
  const profiles = defaultProtocolConfigs().map((profile) => {
    if (profile.type === "vmess") {
      return {
        ...profile,
        enabled: true,
        transport: { type: "grpc", path: "/ignored", serviceName: "raylink" }
      };
    }
    if (profile.type === "vless") {
      return {
        ...profile,
        enabled: true,
        transport: { type: "quic", path: "/ignored", serviceName: "" }
      };
    }
    return { ...profile, enabled: false };
  });
  const [vmess, vless] = buildProtocolInbounds({
    profiles,
    users: eligibleUsers,
    masterPassword: "c2VydmVyLWtleS0xNg=="
  });

  assert.deepEqual(vmess.transport, { type: "grpc", service_name: "raylink" });
  assert.deepEqual(vless.transport, { type: "quic" });
});

test("advanced JSON cannot override fields managed by RayLink", () => {
  assert.throws(
    () => normalizeProtocolConfig({
      ...defaultProtocolConfigs()[0],
      options: { tls: { enabled: true } }
    }),
    (error) => error.code === "PROTOCOL_OPTION_RESERVED"
  );
});

test("QUIC transport cannot be enabled without TLS", () => {
  const vless = defaultProtocolConfigs().find((profile) => profile.type === "vless");
  assert.throws(
    () => normalizeProtocolConfig({
      ...vless,
      enabled: true,
      transport: { type: "quic", path: "", serviceName: "" }
    }),
    (error) => error.code === "TRANSPORT_TLS_REQUIRED"
  );
});
