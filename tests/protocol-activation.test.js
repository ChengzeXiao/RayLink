import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RayLinkStore } from "../server/database.js";

import {
  ProtocolActivationManager,
  protocolActivationPolicy,
  UfwFirewallManager
} from "../server/protocol-activation.js";

function profile(type, overrides = {}) {
  return {
    type,
    enabled: false,
    listen: "::",
    port: {
      shadowsocks: 8388,
      vless: 8444,
      hysteria2: 8448,
      direct: 9090
    }[type],
    tls: {
      mode: "none",
      serverName: "",
      certificatePath: "",
      keyPath: "",
      handshakeServer: "",
      handshakePort: 443,
      privateKey: "",
      publicKey: "",
      shortId: "",
      acmeEmail: ""
    },
    transport: { type: "none", path: "", serviceName: "" },
    options: {},
    ...overrides
  };
}

function fixture(type, overrides = {}) {
  const profiles = structuredClone(overrides.profiles || [
    profile("shadowsocks"),
    profile("vless"),
    profile("hysteria2"),
    profile("direct")
  ]);
  const original = structuredClone(profiles.find((item) => item.type === type));
  const events = [];
  const activations = new Map(
    (overrides.protocolActivations || []).map((activation) => [activation.type, activation])
  );
  const store = {
    getHost: () => ({
      id: "local",
      kind: overrides.kind || "local",
      address: overrides.address || "node.example.com",
      runtimeVersion: "1.13.14",
      platform: "linux",
      buildTags: ["with_utls", "with_acme", "with_quic"],
      protocolActivations: [...activations.values()]
    }),
    listHostProtocolConfigs: () => structuredClone(profiles),
    updateHostProtocolConfig: (_hostId, protocolType, input) => {
      const index = profiles.findIndex((item) => item.type === protocolType);
      profiles[index] = {
        ...profiles[index],
        ...structuredClone(input),
        tls: { ...profiles[index].tls, ...(input.tls || {}) },
        transport: { ...profiles[index].transport, ...(input.transport || {}) }
      };
      events.push(["store", structuredClone(profiles[index])]);
      return structuredClone(profiles[index]);
    },
    setProtocolActivation: (_hostId, protocolType, activation) => {
      events.push(["state", protocolType, activation.state]);
      const value = { type: protocolType, ...structuredClone(activation) };
      activations.set(protocolType, value);
      return value;
    }
  };
  const portManager = {
    findAvailable: async ({ preferredPort, network, listen }) => {
      events.push(["port", preferredPort, network, listen]);
      return overrides.port || preferredPort;
    },
    waitForListening: async (input) => {
      events.push(["listening", input.network, input.port]);
      if (overrides.listenerError) throw new Error("端口未监听");
      return true;
    }
  };
  const firewallManager = {
    open: async (input) => {
      events.push(["firewall-open", input.network, input.port]);
      return {
        managed: true,
        rollback: async () => events.push(["firewall-rollback", input.network, input.port])
      };
    }
  };
  const publicProbe = {
    verify: async (input) => {
      events.push(["public-probe", input.network, input.port]);
      if (overrides.publicError) throw new Error("公网不可达");
      return {
        reachable: true,
        ...(Number.isFinite(overrides.publicLatencyMs)
          ? { latencyMs: overrides.publicLatencyMs }
          : {})
      };
    }
  };
  const protocolProbe = async (input) => {
    events.push(["protocol-probe", input.type, input.port]);
    if (overrides.protocolProbeError) throw new Error("协议握手失败");
    const sequence = overrides.protocolSamples?.[input.type];
    const sample = Array.isArray(sequence)
      ? sequence.shift()
      : undefined;
    if (sample instanceof Error) throw sample;
    const latencyMs = input.network === "udp"
      ? sample ?? overrides.protocolLatencyMs
      : sample ?? overrides.publicLatencyMs;
    return {
      reachable: true,
      probe: "sing-box-tools-fetch",
      protocol: input.type,
      ...(Number.isFinite(latencyMs)
        ? { latencyMs }
        : {})
    };
  };
  const runtimeManager = {
    publish: async (_adminId, options) => {
      events.push(["publish", options]);
      return { id: "deployment-1", status: "active", remoteQueued: 0 };
    },
    compileHostRuntimeConfig: () => ({ inbounds: [] })
  };
  const installer = {
    status: async () => ({
      installed: true,
      version: "1.13.14",
      platform: "linux",
      tags: ["with_utls", "with_acme", "with_quic"]
    }),
    generateRealityKeypair: async () => ({
      privateKey: "private-key",
      publicKey: "public-key"
    })
  };
  const manager = new ProtocolActivationManager({
    store,
    runtimeManager,
    installer,
    portManager,
    firewallManager,
    publicProbe,
    protocolProbe,
    certificateEmail: () => "ops@example.com",
    certificateProvider: overrides.certificateProvider,
    certificateStager: overrides.certificateStager,
    randomBytes: () => Buffer.from("0011223344556677", "hex")
  });
  return { manager, events, profiles, original, activations };
}

test("protocol policies separate public, TLS, private and advanced behavior", () => {
  assert.equal(protocolActivationPolicy("shadowsocks").group, "one-click");
  assert.equal(protocolActivationPolicy("trojan").group, "tls");
  assert.equal(protocolActivationPolicy("vmess").tls, "managed-certificate");
  assert.equal(protocolActivationPolicy("trojan").tls, "managed-certificate");
  assert.equal(protocolActivationPolicy("vless").tls, "managed-certificate");
  assert.equal(protocolActivationPolicy("anytls").tls, "managed-certificate");
  assert.equal(protocolActivationPolicy("hysteria2").network, "udp");
  assert.equal(protocolActivationPolicy("socks").exposure, "private");
  assert.equal(protocolActivationPolicy("direct").group, "advanced");
});

test("one-click Shadowsocks activation reserves a port, opens TCP, publishes and probes", async () => {
  const { manager, events, profiles } = fixture("shadowsocks", { port: 18388 });

  const result = await manager.enable({
    hostId: "local",
    type: "shadowsocks",
    adminId: "admin-1"
  });

  const enabled = profiles.find((item) => item.type === "shadowsocks");
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.port, 18388);
  assert.equal(enabled.listen, "::");
  assert.equal(result.activation.state, "public-ready");
  assert.deepEqual(events.filter(([name]) => name === "firewall-open")[0], [
    "firewall-open",
    "tcp",
    18388
  ]);
  assert.equal(events.some(([name]) => name === "publish"), true);
  assert.equal(events.some(([name]) => name === "listening"), true);
  assert.equal(events.some(([name]) => name === "protocol-probe"), true);
});

test("Host latency measurement records TCP and UDP protocol results without changing profiles", async () => {
  const { manager, profiles, activations } = fixture("shadowsocks", {
    profiles: [
      profile("shadowsocks", { enabled: true }),
      profile("hysteria2", { enabled: true }),
      profile("direct")
    ],
    publicLatencyMs: 24,
    protocolLatencyMs: 61
  });

  const measured = await manager.measureHost({ hostId: "local" });

  assert.deepEqual(
    measured.results.map(({ type, status, latencyMs }) => ({ type, status, latencyMs })),
    [
      { type: "shadowsocks", status: "available", latencyMs: 24 },
      { type: "hysteria2", status: "available", latencyMs: 61 }
    ]
  );
  assert.equal(profiles.find((item) => item.type === "shadowsocks").enabled, true);
  assert.equal(activations.get("shadowsocks").publicCheck.latencyMs, 24);
  assert.equal(activations.get("hysteria2").publicCheck.latencyMs, 61);
});

for (const change of ["endpoint", "port"]) {
test(`Host measurement discards an in-flight result after the ${change} changes`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-probe-endpoint-"));
  const store = new RayLinkStore({ dbPath: join(directory, "raylink.db"), adminUsername: "admin", adminPassword: "test-password" });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  store.updateHostProtocolConfig("local", "shadowsocks", { enabled: true });
  store.markHostProtocolsApplied("local", store.listHostProtocolConfigs("local"));
  let started;
  let release;
  const probing = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const probed = [];
  const manager = new ProtocolActivationManager({ store, runtimeManager: {}, installer: {},
    protocolProbe: async ({ address, port }) => {
      probed.push({ address, port });
      started();
      await gate;
      return { reachable: true, latencyMs: 20, probe: "sing-box-tools-fetch" };
    }
  });
  const pending = manager.measureHost({ hostId: "local" });
  await probing;
  if (change === "endpoint") store.updateHost("local", { address: "changed.example.com" });
  else store.updateHostProtocolConfig("local", "shadowsocks", { port: 18388 });
  release();
  const result = await pending;
  assert.deepEqual(result.results, [{ type: "shadowsocks", status: "skipped", reason: "configuration-changed", retryable: true }]);
  assert.equal(store.getHost("local").protocolActivations.find((entry) => entry.type === "shadowsocks")?.publicCheck, undefined);
  if (change === "port") {
    const beforePublication = await manager.measureHost({ hostId: "local" });
    assert.deepEqual(beforePublication.results, [{ type: "shadowsocks", status: "skipped", reason: "configuration-changed", retryable: true }]);
    store.markHostProtocolsApplied("local", store.listHostProtocolConfigs("local"));
  }
  const retried = await manager.measureHost({ hostId: "local" });
  assert.equal(retried.results[0].status, "available");
  assert.equal(probed.at(-1).address, store.getHost("local").address);
  assert.equal(probed.at(-1).port, store.listHostProtocolConfigs("local").find((entry) => entry.type === "shadowsocks").port);
  assert.equal(store.getHost("local").protocolActivations.find((entry) => entry.type === "shadowsocks").publicCheck.reachable, true);
});
}

test("Host connection measurement reports P50, P95 and robust jitter from five samples", async () => {
  const { manager, activations } = fixture("shadowsocks", {
    profiles: [
      profile("shadowsocks", { enabled: true })
    ],
    protocolSamples: {
      shadowsocks: [20, 40, 30, 50, 25]
    }
  });

  const measured = await manager.measureHost({ hostId: "local" });

  assert.deepEqual(measured.results, [{
    type: "shadowsocks",
    status: "available",
    latencyMs: 30,
    jitterMs: 10,
    sampleCount: 5,
    successfulSamples: 5
  }]);
  assert.deepEqual(
    activations.get("shadowsocks").publicCheck.samples,
    {
      count: 5,
      successful: 5,
      failed: 0,
      minMs: 20,
      maxMs: 50
    }
  );
  assert.equal(activations.get("shadowsocks").publicCheck.latencyMs, 30);
  assert.equal(activations.get("shadowsocks").publicCheck.p95Ms, 50);
  assert.equal(activations.get("shadowsocks").publicCheck.jitterMs, 10);
  assert.equal(activations.get("shadowsocks").publicCheck.healthWindow.successRate, 100);
  assert.equal(activations.get("shadowsocks").publicCheck.healthWindow.rounds.length, 1);
  assert.equal(activations.get("shadowsocks").publicCheck.consecutiveFailures, 0);
});

test("Host connection measurement requires three consecutive failed rounds before timeout", async () => {
  const failedSamples = Array.from(
    { length: 15 },
    () => new Error("connection timed out")
  );
  const previousCheck = {
    reachable: true,
    latencyMs: 88,
    jitterMs: 7,
    checkedAt: "2026-07-28T10:00:00.000Z",
    lastSuccessAt: "2026-07-28T10:00:00.000Z",
    consecutiveFailures: 0
  };
  const { manager, activations } = fixture("shadowsocks", {
    profiles: [
      profile("shadowsocks", { enabled: true })
    ],
    protocolActivations: [{
      type: "shadowsocks",
      state: "public-ready",
      publicCheck: previousCheck
    }],
    protocolSamples: {
      shadowsocks: failedSamples
    }
  });

  const first = await manager.measureHost({ hostId: "local" });
  assert.equal(first.results[0].status, "degraded");
  assert.equal(activations.get("shadowsocks").publicCheck.reachable, true);
  assert.equal(activations.get("shadowsocks").publicCheck.consecutiveFailures, 1);
  assert.equal(activations.get("shadowsocks").publicCheck.latencyMs, 88);

  const second = await manager.measureHost({ hostId: "local" });
  assert.equal(second.results[0].status, "degraded");
  assert.equal(activations.get("shadowsocks").publicCheck.reachable, true);
  assert.equal(activations.get("shadowsocks").publicCheck.consecutiveFailures, 2);

  const third = await manager.measureHost({ hostId: "local" });
  assert.equal(third.results[0].status, "timeout");
  assert.equal(activations.get("shadowsocks").publicCheck.reachable, false);
  assert.equal(activations.get("shadowsocks").publicCheck.consecutiveFailures, 3);
  assert.equal(
    activations.get("shadowsocks").publicCheck.lastSuccessAt,
    "2026-07-28T10:00:00.000Z"
  );
});

test("Host connection measurement requires at least four successful samples", async () => {
  const { manager, activations } = fixture("shadowsocks", {
    profiles: [
      profile("shadowsocks", { enabled: true })
    ],
    protocolActivations: [{
      type: "shadowsocks",
      state: "public-ready",
      publicCheck: {
        reachable: true,
        latencyMs: 90,
        jitterMs: 8,
        checkedAt: "2026-07-28T10:00:00.000Z",
        consecutiveFailures: 0
      }
    }],
    protocolSamples: {
      shadowsocks: [
        20,
        new Error("connection timed out"),
        30,
        new Error("connection timed out"),
        new Error("connection timed out")
      ]
    }
  });

  const measured = await manager.measureHost({ hostId: "local" });

  assert.equal(measured.results[0].status, "degraded");
  assert.equal(activations.get("shadowsocks").publicCheck.consecutiveFailures, 1);
  assert.equal(activations.get("shadowsocks").publicCheck.latencyMs, 90);
  assert.deepEqual(
    activations.get("shadowsocks").publicCheck.samples,
    {
      count: 5,
      successful: 2,
      failed: 3,
      minMs: 20,
      maxMs: 30
    }
  );
  assert.equal(measured.results[0].successfulSamples, 2);
});

test("a three-of-five protocol round is degraded instead of being declared available", async () => {
  const { manager, activations } = fixture("hysteria2", {
    profiles: [
      profile("hysteria2", { enabled: true })
    ],
    protocolActivations: [{
      type: "hysteria2",
      state: "public-ready",
      publicCheck: {
        reachable: true,
        latencyMs: 70,
        jitterMs: 5,
        checkedAt: "2026-07-28T10:00:00.000Z",
        consecutiveFailures: 0
      }
    }],
    protocolSamples: {
      hysteria2: [
        40,
        new Error("connection timed out"),
        50,
        new Error("connection timed out"),
        60
      ]
    }
  });

  const measured = await manager.measureHost({ hostId: "local" });

  assert.equal(measured.results[0].status, "degraded");
  assert.equal(measured.results[0].successfulSamples, 3);
  assert.equal(activations.get("hysteria2").publicCheck.availability, "degraded");
  assert.equal(activations.get("hysteria2").publicCheck.consecutiveFailures, 1);
  assert.equal(activations.get("hysteria2").publicCheck.healthWindow.successRate, 60);
});

test("Host latency measurement marks enabled local-only protocols as not applicable", async () => {
  const { manager, activations } = fixture("shadowsocks", {
    profiles: [
      profile("shadowsocks", { enabled: true }),
      profile("socks", { enabled: true, listen: "127.0.0.1", port: 1080 })
    ],
    publicLatencyMs: 24
  });

  const measured = await manager.measureHost({ hostId: "local" });

  assert.deepEqual(
    measured.results.map(({ type, status }) => ({ type, status })),
    [
      { type: "shadowsocks", status: "available" },
      { type: "socks", status: "unsupported" }
    ]
  );
  assert.equal(activations.get("socks").publicCheck.unsupported, true);
  assert.match(activations.get("socks").publicCheck.reason, /仅本机/);
});

test("one-click VLESS uses the Host certificate for sing-box client compatibility", async () => {
  const { manager, profiles } = fixture("vless");

  await manager.enable({ hostId: "local", type: "vless", adminId: "admin-1" });

  const enabled = profiles.find((item) => item.type === "vless");
  assert.equal(enabled.tls.mode, "acme");
  assert.equal(enabled.tls.serverName, "node.example.com");
  assert.equal(enabled.tls.acmeEmail, "ops@example.com");
});

test("one-click Hysteria 2 binds node domain to ACME and opens UDP", async () => {
  const { manager, events, profiles } = fixture("hysteria2");

  await manager.enable({ hostId: "local", type: "hysteria2", adminId: "admin-1" });

  const enabled = profiles.find((item) => item.type === "hysteria2");
  assert.equal(enabled.tls.mode, "acme");
  assert.equal(enabled.tls.serverName, "node.example.com");
  assert.equal(enabled.tls.acmeEmail, "ops@example.com");
  assert.deepEqual(events.filter(([name]) => name === "firewall-open"), [
    ["firewall-open", "udp", 8448],
    ["firewall-open", "tcp", 80],
    ["firewall-open", "tcp", 443]
  ]);
  assert.deepEqual(
    events.filter(([name]) => name === "protocol-probe"),
    [["protocol-probe", "hysteria2", 8448]]
  );
  assert.equal(events.some(([name]) => name === "public-probe"), false);
});

test("local Hysteria 2 stages a Caddy certificate before publishing", async () => {
  const { manager, profiles } = fixture("hysteria2", {
    certificateProvider: async () => ({
      serverName: "node.example.com",
      certificatePath: "/var/lib/caddy/private/node.crt",
      keyPath: "/var/lib/caddy/private/node.key",
      rollback: async () => {}
    }),
    certificateStager: async ({ domain, certificatePath, keyPath }) => {
      assert.equal(domain, "node.example.com");
      assert.equal(certificatePath, "/var/lib/caddy/private/node.crt");
      assert.equal(keyPath, "/var/lib/caddy/private/node.key");
      return {
        certificatePath: "/var/lib/raylink/sing-box/tls/node.crt",
        keyPath: "/var/lib/raylink/sing-box/tls/node.key",
        rollback: async () => {}
      };
    }
  });

  await manager.enable({ hostId: "local", type: "hysteria2", adminId: "admin-1" });

  const enabled = profiles.find((item) => item.type === "hysteria2");
  assert.equal(
    enabled.tls.certificatePath,
    "/var/lib/raylink/sing-box/tls/node.crt"
  );
  assert.equal(
    enabled.tls.keyPath,
    "/var/lib/raylink/sing-box/tls/node.key"
  );
});

test("failed local TLS activation rolls back both staged assets and Caddy", async () => {
  const rollbacks = [];
  const { manager, profiles, original } = fixture("hysteria2", {
    protocolProbeError: true,
    certificateProvider: async () => ({
      serverName: "node.example.com",
      certificatePath: "/var/lib/caddy/private/node.crt",
      keyPath: "/var/lib/caddy/private/node.key",
      rollback: async () => rollbacks.push("caddy")
    }),
    certificateStager: async () => ({
      certificatePath: "/var/lib/raylink/sing-box/tls/node.crt",
      keyPath: "/var/lib/raylink/sing-box/tls/node.key",
      rollback: async () => rollbacks.push("staged-assets")
    })
  });

  await assert.rejects(
    manager.enable({ hostId: "local", type: "hysteria2", adminId: "admin-1" }),
    /协议握手失败/
  );

  assert.deepEqual(
    profiles.find((item) => item.type === "hysteria2"),
    original
  );
  assert.deepEqual(rollbacks, ["staged-assets", "caddy"]);
});

test("advanced protocols cannot be one-click exposed", async () => {
  const { manager } = fixture("direct");

  await assert.rejects(
    manager.enable({ hostId: "local", type: "direct", adminId: "admin-1" }),
    (error) => error.code === "PROTOCOL_ADVANCED_ONLY"
  );
});

test("a remote port collision advances to the next candidate without reusing the failed port", async () => {
  const { manager, profiles } = fixture("vless", {
    kind: "remote",
    protocolActivations: [{
      type: "vless",
      state: "failed",
      errorCode: "PROTOCOL_PORT_OCCUPIED",
      port: 8444,
      suggestedPort: 8450
    }]
  });

  const result = await manager.enable({
    hostId: "local",
    type: "vless",
    adminId: "admin-1"
  });

  assert.equal(profiles.find((item) => item.type === "vless").port, 8450);
  assert.equal(result.activation.state, "deploying");
  assert.equal(result.activation.asynchronous, true);
});

test("failed public verification restores protocol config and firewall", async () => {
  const { manager, events, profiles, original } = fixture("shadowsocks", {
    protocolProbeError: true
  });

  await assert.rejects(
    manager.enable({ hostId: "local", type: "shadowsocks", adminId: "admin-1" }),
    /协议握手失败/
  );

  assert.deepEqual(profiles.find((item) => item.type === "shadowsocks"), original);
  assert.equal(events.some(([name]) => name === "firewall-rollback"), true);
  assert.equal(
    events.some(([name, , state]) => name === "state" && state === "failed"),
    true
  );
  assert.equal(events.filter(([name]) => name === "publish").length, 2);
});

test("UFW activation preserves an equivalent rule that existed before RayLink", async () => {
  const commands = [];
  const firewall = new UfwFirewallManager({
    commandRunner: async (command, args) => {
      commands.push([command, ...args]);
      return {
        stdout: "Status: active\n\n8444/tcp ALLOW Anywhere\n",
        stderr: ""
      };
    }
  });

  const opened = await firewall.open({ port: 8444, network: "tcp" });
  await opened.rollback();

  assert.equal(opened.managed, false);
  assert.equal(opened.preexisting, true);
  assert.deepEqual(commands, [["ufw", "status"]]);
});
