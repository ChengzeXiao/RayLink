import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  NodeRuntimeAdapter,
  NodeTelemetryCollector,
  NodeUsageCollector,
  RayLinkNode
} from "../web/node/raylink-node.mjs";

function jsonResponse(body, status = 200) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" }
  });
}

test("RayLink Node retries a durable success receipt after restart without reapplying the config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-receipt-"));
  const statePath = join(directory, "node.json");
  const completions = [];
  let publications = 0;
  let delivered = false;
  const options = {
    serverUrl: "https://panel.example.com",
    enrollmentToken: "token",
    statePath,
    metadataProvider: async () => ({ buildTags: [] }),
    runtimeAdapter: { publish: async () => {
      publications += 1;
      return { runtimeVersion: "1.14.2" };
    } },
    fetchFn: async (url, init) => {
      if (url.endsWith("/enroll")) return jsonResponse({ hostId: "host", nodeSecret: "secret" });
      if (url.endsWith("/heartbeat")) return jsonResponse({ ok: true });
      if (url.endsWith("/next")) return delivered
        ? jsonResponse(undefined, 204)
        : jsonResponse({ id: "task-1", attempt: 1, kind: "publish-config", payload: {} });
      if (url.endsWith("/complete")) {
        completions.push(JSON.parse(init.body));
        if (completions.length === 1) throw new Error("connection lost after task execution");
        delivered = true;
        return jsonResponse({ status: "succeeded" });
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  };
  await assert.rejects(new RayLinkNode(options).pollOnce(), /connection lost/);
  assert.deepEqual(completions.map(({ status }) => status), ["succeeded"]);
  await new RayLinkNode(options).pollOnce();
  assert.equal(publications, 1);
  assert.deepEqual(completions.map(({ status }) => status), ["succeeded", "succeeded"]);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).pendingTaskReceipt, undefined);
});

test("RayLink Node surfaces the control-plane error message", async () => {
  const node = new RayLinkNode({
    serverUrl: "https://panel.example.com",
    fetchFn: async () => jsonResponse({
      error: {
        code: "NODE_UPGRADE_REQUIRED",
        message: "请先升级 RayLink Node"
      }
    }, 426)
  });

  await assert.rejects(
    () => node.request("/api/node/tasks/next"),
    /请先升级 RayLink Node/
  );
});

test("RayLink Node times out an unresponsive control plane", async () => {
  const node = new RayLinkNode({
    serverUrl: "https://panel.example.com",
    requestTimeoutMs: 20,
    fetchFn: async (_url, init) => new Promise((_resolve, reject) => {
      const holdOpen = setTimeout(() => reject(new Error("request remained open")), 200);
      init.signal.addEventListener("abort", () => {
        clearTimeout(holdOpen);
        reject(init.signal.reason);
      }, { once: true });
    })
  });

  await assert.rejects(
    () => node.request("/api/node/heartbeat"),
    /控制面请求超时/
  );
});

test("RayLink Node enrolls once and persists its node credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-enroll-"));
  const statePath = join(directory, "node.json");
  const requests = [];
  const node = new RayLinkNode({
    serverUrl: "https://panel.example.com",
    enrollmentToken: "one-time-token",
    statePath,
    metadataProvider: async () => ({
      hostname: "fra-vps-02",
      platform: "linux",
      architecture: "x64",
      agentVersion: "0.1.0",
      runtimeVersion: "1.13.12",
      buildTags: ["with_quic"]
    }),
    fetchFn: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({ hostId: "host-fra", nodeSecret: "node-secret" }, 201);
    }
  });

  const state = await node.ensureEnrolled();

  assert.equal(state.hostId, "host-fra");
  assert.equal(state.nodeSecret, "node-secret");
  assert.match(state.encryptionPublicKey, /BEGIN PUBLIC KEY/);
  assert.match(state.encryptionPrivateKey, /BEGIN PRIVATE KEY/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://panel.example.com/api/node/enroll");
  assert.equal(JSON.parse(requests[0].init.body).hostname, "fra-vps-02");
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.hostId, "host-fra");
  assert.equal(persisted.nodeSecret, "node-secret");
  assert.match(persisted.encryptionPrivateKey, /BEGIN PRIVATE KEY/);

  await node.ensureEnrolled();
  assert.equal(requests.length, 1);
});

test("RayLink Node rejects a counter sample spanning a Runtime restart and retains the next cumulative sample", async () => {
  let instance = "runtime-before";
  let bytes = 150;
  const collector = new NodeUsageCollector({
    instanceProvider: async () => instance,
    query: async () => {
      instance = "runtime-after";
      return [{ name: "user>>>usage@example.com>>>traffic>>>uplink", value: bytes }];
    }
  });
  await assert.rejects(collector.collect(), /Runtime 实例发生变化/);
  bytes = 175;
  const next = await collector.collect();
  assert.equal(next.runtimeInstanceId, "runtime-after");
  assert.deepEqual(next.users, [{ name: "usage@example.com", uplinkBytes: 175, downlinkBytes: 0 }]);
});

test("RayLink Node collects cumulative per-user usage without resetting Runtime counters", async () => {
  const collector = new NodeUsageCollector({
    query: async () => [
      { name: "user>>>zane@example.com>>>traffic>>>uplink", value: 4_096 },
      { name: "user>>>zane@example.com>>>traffic>>>downlink", value: 12_288 }
    ],
    instanceProvider: async () => "runtime-invocation-01",
    clock: () => new Date("2026-07-26T12:00:00.000Z"),
    sampleId: () => "usage-sample-01"
  });

  assert.deepEqual(await collector.collect(), {
    sampleId: "usage-sample-01",
    runtimeInstanceId: "runtime-invocation-01",
    observedAt: "2026-07-26T12:00:00.000Z",
    users: [{
      name: "zane@example.com",
      uplinkBytes: 4_096,
      downlinkBytes: 12_288
    }]
  });
});

test("RayLink Node heartbeats, applies the next config and reports success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-publish-"));
  const statePath = join(directory, "node.json");
  const calls = [];
  const publications = [];
  const responses = [
    jsonResponse({ hostId: "host-fra", nodeSecret: "node-secret" }, 201),
    jsonResponse({ ok: true }),
    jsonResponse({
      id: "task-1",
      kind: "publish-config",
      attempt: 1,
      payload: {
        version: 4,
        checksum: "sha256:config",
        configText: "{\"log\":{\"level\":\"info\"}}"
      }
    }),
    jsonResponse({ ok: true })
  ];
  const node = new RayLinkNode({
    serverUrl: "https://panel.example.com/",
    enrollmentToken: "one-time-token",
    statePath,
    metadataProvider: async () => ({
      hostname: "fra-vps-02",
      platform: "linux",
      architecture: "x64",
      agentVersion: "0.1.0",
      runtimeVersion: "1.13.12",
      buildTags: ["with_quic"]
    }),
    runtimeAdapter: {
      async publish(task) {
        publications.push(task);
        return { runtimeVersion: "1.13.12", configPath: "/var/lib/raylink-node/sing-box/config.json" };
      }
    },
    fetchFn: async (url, init = {}) => {
      calls.push({ url, init });
      return responses.shift();
    }
  });

  await node.pollOnce();

  assert.equal(publications.length, 1);
  assert.equal(publications[0].configText, "{\"log\":{\"level\":\"info\"}}");
  const heartbeat = calls.find((call) => call.url.endsWith("/api/node/heartbeat"));
  assert.equal(heartbeat.init.headers.authorization, "Bearer node-secret");
  assert.equal(heartbeat.init.headers["x-raylink-host-id"], "host-fra");
  const completion = calls.find((call) => call.url.endsWith("/api/node/tasks/task-1/complete"));
  assert.deepEqual(JSON.parse(completion.init.body), {
    attempt: 1,
    status: "succeeded",
    result: {
      runtimeVersion: "1.13.12",
      configPath: "/var/lib/raylink-node/sing-box/config.json"
    }
  });
});

test("RayLink Node reports a failed task without swallowing the next poll cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-failure-"));
  const calls = [];
  const responses = [
    jsonResponse({ hostId: "host-fra", nodeSecret: "node-secret" }, 201),
    jsonResponse({ ok: true }),
    jsonResponse({
      id: "task-2",
      kind: "publish-config",
      attempt: 3,
      payload: { version: 5, checksum: "sha256:bad", configText: "{}" }
    }),
    jsonResponse({ ok: true })
  ];
  const node = new RayLinkNode({
    serverUrl: "https://panel.example.com",
    enrollmentToken: "one-time-token",
    statePath: join(directory, "node.json"),
    metadataProvider: async () => ({ hostname: "fra-vps-02" }),
    runtimeAdapter: {
      async publish() {
        throw new Error("sing-box check failed");
      }
    },
    fetchFn: async (url, init = {}) => {
      calls.push({ url, init });
      return responses.shift();
    }
  });

  await node.pollOnce();

  const completion = calls.find((call) => call.url.endsWith("/api/node/tasks/task-2/complete"));
  assert.deepEqual(JSON.parse(completion.init.body), {
    attempt: 3,
    status: "failed",
    result: { error: "sing-box check failed" }
  });
});

test("remote TCP protocol activation performs a real protocol probe before reporting readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-activation-"));
  const events = [];
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    binaryPath: "sing-box",
    runtimeMode: "dry-run",
    commandRunner: async () => ({ stdout: "sing-box version 1.14.2\n", stderr: "" }),
    firewallManager: {
      open: async (activation) => {
        events.push(["firewall", activation.network, activation.port]);
        return { managed: true, rollback: async () => events.push(["firewall-rollback"]) };
      }
    },
    portVerifier: {
      waitForListening: async (activation) => events.push(["listening", activation.port])
    },
    protocolProbe: {
      verify: async (activation) => {
        events.push(["protocol", activation.type, activation.address, activation.port]);
        return { reachable: true, probe: "sing-box-tools-fetch" };
      }
    }
  });

  const result = await adapter.publish({
    version: "v1",
    checksum: "checksum",
    configText: "{\"inbounds\":[]}",
    activation: {
      type: "vless",
      exposure: "public",
      network: "tcp",
      address: "node.example.com",
      listen: "::",
      port: 18444
    }
  });

  assert.deepEqual(events, [
    ["firewall", "tcp", 18444],
    ["listening", 18444],
    ["protocol", "vless", "node.example.com", 18444]
  ]);
  assert.deepEqual(result.activation.publicCheck, {
    reachable: true,
    probe: "sing-box-tools-fetch"
  });
  assert.equal(result.activation.firewallManaged, true);
});

test("Hysteria 2 activation completes a real sing-box protocol fetch before reporting public readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-hysteria2-probe-"));
  let probeConfig = null;
  let probeAttempts = 0;
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    binaryPath: "sing-box",
    runtimeMode: "dry-run",
    commandRunner: async (command, args) => {
      if (command === "sing-box" && args[0] === "tools" && args[1] === "fetch") {
        probeAttempts += 1;
        const configPath = args[args.indexOf("-c") + 1];
        probeConfig = JSON.parse(await readFile(configPath, "utf8"));
        if (probeAttempts === 1) throw new Error("temporary probe failure");
        return { stdout: "", stderr: "" };
      }
      return { stdout: "sing-box version 1.14.2\n", stderr: "" };
    },
    protocolProbeDelayMs: 0,
    firewallManager: {
      open: async () => ({ managed: true, rollback: async () => {} })
    },
    portVerifier: {
      assertAvailable: async () => true,
      waitForListening: async () => true
    },
    publicProbe: {
      verify: async () => {
        throw new Error("generic UDP probe must not be used");
      }
    }
  });
  const configText = JSON.stringify({
    inbounds: [{
      type: "hysteria2",
      tag: "raylink-hysteria2",
      listen: "::",
      listen_port: 8448,
      users: [{ name: "probe@example.com", password: "probe-password" }],
      tls: {
        enabled: true,
        server_name: "node.example.com",
        acme: {
          domain: ["node.example.com"],
          email: "ops@example.com"
        }
      }
    }]
  });

  const result = await adapter.publish({
    version: "v1",
    checksum: "checksum",
    configText,
    activation: {
      type: "hysteria2",
      exposure: "public",
      network: "udp",
      address: "node.example.com",
      listen: "::",
      port: 8448
    }
  });

  const { latencyMs, ...publicCheck } = result.activation.publicCheck;
  assert.equal(Number.isInteger(latencyMs), true);
  assert.ok(latencyMs >= 0);
  assert.deepEqual(publicCheck, {
    reachable: true,
    probe: "sing-box-tools-fetch",
    protocol: "hysteria2",
    target: "https://www.gstatic.com/generate_204"
  });
  assert.equal(probeAttempts, 2);
  assert.deepEqual(probeConfig.outbounds, [{
    type: "hysteria2",
    tag: "raylink-probe",
    server: "node.example.com",
    server_port: 8448,
    password: "probe-password",
    tls: {
      enabled: true,
      server_name: "node.example.com"
    }
  }]);
});

test("a failed TUIC protocol probe restores the previous config and firewall rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-tuic-probe-rollback-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, "{\"previous\":true}\n");
  const rollbacks = [];
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    binaryPath: "sing-box",
    runtimeMode: "dry-run",
    commandRunner: async () => ({ stdout: "sing-box version 1.14.2\n", stderr: "" }),
    firewallManager: {
      open: async ({ port, network }) => ({
        managed: true,
        rollback: async () => rollbacks.push(`${port}/${network}`)
      })
    },
    portVerifier: {
      assertAvailable: async () => true,
      waitForListening: async () => true
    },
    protocolProbe: {
      verify: async () => {
        const error = new Error("TUIC 握手超时");
        error.code = "PROTOCOL_HANDSHAKE_FAILED";
        throw error;
      }
    }
  });

  await assert.rejects(
    adapter.publish({
      version: "v1",
      checksum: "checksum",
      configText: JSON.stringify({
        inbounds: [{
          type: "tuic",
          listen_port: 8447,
          users: [{
            uuid: "d5d29d63-1dad-4e45-9d0b-d4a012b71015",
            password: "probe-password"
          }],
          tls: { enabled: true, server_name: "node.example.com" }
        }]
      }),
      activation: {
        type: "tuic",
        exposure: "public",
        network: "udp",
        address: "node.example.com",
        listen: "::",
        port: 8447,
        challengePorts: [
          { port: 80, network: "tcp" },
          { port: 443, network: "tcp" }
        ]
      }
    }),
    (error) => error.code === "PROTOCOL_HANDSHAKE_FAILED"
      && error.rolledBack === true
  );

  assert.equal(await readFile(configPath, "utf8"), "{\"previous\":true}\n");
  assert.deepEqual(rollbacks, ["443/tcp", "80/tcp", "8447/udp"]);
});

test("RayLink Node default UFW manager opens and rolls back only its own rule", async () => {
  const calls = [];
  const adapter = new NodeRuntimeAdapter({
    runtimeMode: "dry-run",
    commandRunner: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "ufw" && args[0] === "status") {
        return { stdout: "Status: active\n22/tcp ALLOW Anywhere\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }
  });

  const opened = await adapter.openFirewall({ port: 18_444, network: "tcp" });

  assert.equal(opened.managed, true);
  assert.deepEqual(calls, [
    ["ufw", "status"],
    ["ufw", "allow", "18444/tcp", "comment", "RayLink managed"]
  ]);
  await opened.rollback();
  assert.deepEqual(calls.at(-1), [
    "ufw",
    "--force",
    "delete",
    "allow",
    "18444/tcp"
  ]);
});

test("remote protocol activation rolls config and firewall back after a failed port check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-activation-rollback-"));
  await writeFile(join(directory, "config.json"), "{\"previous\":true}\n");
  const events = [];
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    binaryPath: "sing-box",
    runtimeMode: "dry-run",
    commandRunner: async () => ({ stdout: "sing-box version 1.14.2\n", stderr: "" }),
    firewallManager: {
      open: async () => ({
        managed: true,
        rollback: async () => events.push("firewall-rollback")
      })
    },
    portVerifier: {
      waitForListening: async () => {
        throw new Error("端口未监听");
      }
    },
    publicProbe: { verify: async () => ({ reachable: true }) }
  });

  await assert.rejects(
    adapter.publish({
      version: "v1",
      checksum: "checksum",
      configText: "{\"next\":true}",
      activation: {
        type: "vless",
        exposure: "public",
        network: "tcp",
        address: "node.example.com",
        listen: "::",
        port: 18444
      }
    }),
    (error) => error.message.includes("端口未监听") && error.rolledBack === true
  );

  assert.equal(await readFile(join(directory, "config.json"), "utf8"), "{\"previous\":true}\n");
  assert.deepEqual(events, ["firewall-rollback"]);
});

test("remote protocol activation rejects an occupied system port before changing firewall or config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-port-conflict-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, "{\"previous\":true}\n");
  let firewallCalls = 0;
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    binaryPath: "sing-box",
    runtimeMode: "dry-run",
    commandRunner: async (command, args) => {
      if (command === "ss") {
        return { stdout: "LISTEN 0 4096 *:18444 *:*\n", stderr: "" };
      }
      return { stdout: "sing-box version 1.14.2\n", stderr: "" };
    },
    firewallManager: {
      open: async () => {
        firewallCalls += 1;
        return { managed: true, rollback: async () => {} };
      }
    }
  });

  await assert.rejects(
    adapter.publish({
      version: "v1",
      checksum: "checksum",
      configText: "{\"next\":true}",
      activation: {
        type: "vless",
        exposure: "public",
        network: "tcp",
        address: "node.example.com",
        listen: "::",
        port: 18444
      }
    }),
    (error) => error.code === "PROTOCOL_PORT_OCCUPIED"
      && error.suggestedPort === 18_445
      && error.rolledBack === true
  );

  assert.equal(firewallCalls, 0);
  assert.equal(await readFile(configPath, "utf8"), "{\"previous\":true}\n");
});

test("RayLink Node applies a runtime upgrade task and reports the new version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-upgrade-task-"));
  const calls = [];
  const upgrades = [];
  const responses = [
    jsonResponse({ hostId: "host-fra", nodeSecret: "node-secret" }, 201),
    jsonResponse({ ok: true }),
    jsonResponse({
      id: "task-upgrade-1",
      kind: "upgrade-runtime",
      attempt: 1,
      payload: { targetVersion: "1.14.2" }
    }),
    jsonResponse({ ok: true })
  ];
  const node = new RayLinkNode({
    serverUrl: "https://panel.example.com",
    enrollmentToken: "one-time-token",
    statePath: join(directory, "node.json"),
    metadataProvider: async () => ({ hostname: "fra-vps-02" }),
    runtimeAdapter: {
      async upgrade(task) {
        upgrades.push(task);
        return { runtimeVersion: task.targetVersion, rolledBack: false };
      }
    },
    fetchFn: async (url, init = {}) => {
      calls.push({ url, init });
      return responses.shift();
    }
  });

  await node.pollOnce();

  assert.deepEqual(upgrades, [{ targetVersion: "1.14.2" }]);
  const completion = calls.find((call) => call.url.endsWith("/api/node/tasks/task-upgrade-1/complete"));
  assert.deepEqual(JSON.parse(completion.init.body), {
    attempt: 1,
    status: "succeeded",
    result: { runtimeVersion: "1.14.2", rolledBack: false }
  });
});

test("RayLink Node reports an automatic Runtime rollback to the control plane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-upgrade-report-"));
  const calls = [];
  const responses = [
    jsonResponse({ hostId: "host-fra", nodeSecret: "node-secret" }, 201),
    jsonResponse({ ok: true }),
    jsonResponse({
      id: "task-upgrade-failed",
      kind: "upgrade-runtime",
      attempt: 1,
      payload: { targetVersion: "1.14.2" }
    }),
    jsonResponse({ ok: true })
  ];
  const node = new RayLinkNode({
    serverUrl: "https://panel.example.com",
    enrollmentToken: "one-time-token",
    statePath: join(directory, "node.json"),
    metadataProvider: async () => ({ hostname: "fra-vps-02" }),
    runtimeAdapter: {
      async upgrade() {
        const error = new Error("candidate failed health window");
        error.previousVersion = "1.13.12";
        error.rolledBack = true;
        throw error;
      }
    },
    fetchFn: async (url, init = {}) => {
      calls.push({ url, init });
      return responses.shift();
    }
  });

  await node.pollOnce();

  const completion = calls.find(
    (call) => call.url.endsWith("/api/node/tasks/task-upgrade-failed/complete")
  );
  assert.deepEqual(JSON.parse(completion.init.body), {
    attempt: 1,
    status: "failed",
    result: {
      error: "candidate failed health window",
      previousVersion: "1.13.12",
      rolledBack: true
    }
  });
});

test("node runtime upgrade rolls the binary back when the new build rejects the active config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-upgrade-rollback-"));
  const binaryPath = join(directory, "sing-box");
  const configPath = join(directory, "config.json");
  await writeFile(binaryPath, "previous-binary");
  await writeFile(configPath, "{}");
  let version = "1.13.12";
  let restarts = 0;
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    binaryPath,
    healthCheckDelayMs: 0,
    commandRunner: async (command, args) => {
      if (command === "sh") {
        version = args[1].match(/--version\s+(\d+\.\d+\.\d+)/)?.[1] || version;
        await writeFile(binaryPath, "broken-binary");
        return { stdout: "", stderr: "" };
      }
      if (command === binaryPath && args[0] === "version") {
        return { stdout: `sing-box version ${version}\n`, stderr: "" };
      }
      if (command === binaryPath && args[0] === "check") throw new Error("candidate rejected config");
      if (command === "systemctl" && args[0] === "restart") {
        restarts += 1;
        return { stdout: "", stderr: "" };
      }
      return { stdout: "active\n", stderr: "" };
    }
  });

  await assert.rejects(adapter.upgrade({ targetVersion: "1.14.2" }), /已回滚/);
  assert.equal(await readFile(binaryPath, "utf8"), "previous-binary");
  assert.equal(restarts, 1);
});

test("node runtime refuses an upgrade before touching a Host without an active config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-upgrade-unconfigured-"));
  const binaryPath = join(directory, "sing-box");
  await writeFile(binaryPath, "previous-binary");
  let installCalls = 0;
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    binaryPath,
    healthCheckDelayMs: 0,
    commandRunner: async (command, args) => {
      if (command === "sh") installCalls += 1;
      if (command === binaryPath && args[0] === "version") {
        return { stdout: "sing-box version 1.13.12\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }
  });

  await assert.rejects(
    adapter.upgrade({ targetVersion: "1.14.2" }),
    /没有活动配置/
  );
  assert.equal(installCalls, 0);
});

test("managed node upgrades an untagged Runtime to the approved metered build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-upgrade-metered-"));
  const binaryPath = join(directory, "sing-box");
  const builderPath = join(directory, "build-metered-runtime.sh");
  await writeFile(binaryPath, "previous-binary");
  await writeFile(builderPath, "#!/bin/sh\n");
  await writeFile(join(directory, "config.json"), "{}");
  let version = "1.14.2";
  let metered = false;
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    binaryPath,
    meteredRuntimeBuilder: builderPath,
    preferMeteredRuntime: true,
    runtimeMode: "dry-run",
    commandRunner: async (command, args) => {
      if (command === "sh" && args[0] === builderPath) {
        version = args[1];
        metered = true;
        return { stdout: "", stderr: "" };
      }
      if (command === binaryPath && args[0] === "version") {
        return {
          stdout: `sing-box version ${version}\n${metered ? "Tags: with_v2ray_api\n" : ""}`,
          stderr: ""
        };
      }
      if (command === binaryPath && args[0] === "check") return { stdout: "", stderr: "" };
      if (command === "systemctl" && args[0] === "list-unit-files") {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }
  });

  const result = await adapter.upgrade({ targetVersion: "1.14.2" });
  assert.equal(result.runtimeVersion, "1.14.2");
  assert.equal(metered, true);
});

test("managed node upgrades from the signed release artifact without compiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-upgrade-release-"));
  const binaryPath = join(directory, "sing-box");
  await writeFile(binaryPath, "previous-binary");
  await writeFile(join(directory, "config.json"), "{}");
  const artifact = Buffer.from("precompiled-runtime");
  const cronetArtifact = Buffer.from("precompiled-cronet");
  const checksum = createHash("sha256").update(artifact).digest("hex");
  const cronetChecksum = createHash("sha256").update(cronetArtifact).digest("hex");
  const downloads = [];
  let installed = false;
  let builderCalls = 0;
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    binaryPath,
    meteredRuntimeBuilder: join(directory, "missing-builder.sh"),
    runtimeArtifactBaseUrl: "https://panel.example.com/node/runtime",
    runtimeArch: "arm64",
    fetchFn: async (url) => {
      downloads.push(url);
      if (url.endsWith("raylink-libcronet-1.14.2-linux-arm64.so.sha256")) {
        installed = true;
        return new Response(`${cronetChecksum}  raylink-libcronet.so\n`);
      }
      if (url.endsWith("raylink-libcronet-1.14.2-linux-arm64.so")) {
        return new Response(cronetArtifact);
      }
      if (url.endsWith(".sha256")) {
        return new Response(`${checksum}  raylink-sing-box\n`);
      }
      return new Response(artifact);
    },
    preferMeteredRuntime: true,
    runtimeMode: "dry-run",
    commandRunner: async (command, args) => {
      if (command === "sh") builderCalls += 1;
      if (command === binaryPath && args[0] === "version") {
        return {
          stdout: installed
            ? "sing-box version 1.14.2\nTags: with_v2ray_api\n"
            : "sing-box version 1.13.13\n",
          stderr: ""
        };
      }
      if (command === binaryPath && args[0] === "check") return { stdout: "", stderr: "" };
      if (command === "systemctl" && args[0] === "list-unit-files") {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }
  });

  const result = await adapter.upgrade({ targetVersion: "1.14.2" });

  assert.equal(result.runtimeVersion, "1.14.2");
  assert.equal(builderCalls, 0);
  assert.deepEqual(downloads, [
    "https://panel.example.com/node/runtime/raylink-sing-box-1.14.2-linux-arm64",
    "https://panel.example.com/node/runtime/raylink-sing-box-1.14.2-linux-arm64.sha256",
    "https://panel.example.com/node/runtime/raylink-libcronet-1.14.2-linux-arm64.so",
    "https://panel.example.com/node/runtime/raylink-libcronet-1.14.2-linux-arm64.so.sha256"
  ]);
  assert.deepEqual(await readFile(binaryPath), artifact);
  assert.deepEqual(await readFile(join(directory, "libcronet.so")), cronetArtifact);
});

test("RayLink Node rejects non-loopback HTTP control planes by default", () => {
  assert.throws(
    () => new RayLinkNode({ serverUrl: "http://panel.example.com" }),
    /必须使用 HTTPS/
  );
  assert.doesNotThrow(
    () => new RayLinkNode({ serverUrl: "http://127.0.0.1:4173" })
  );
});

test("node telemetry reports interval CPU, memory, network and service health", async () => {
  const samples = [
    {
      cpu: { idle: 4_000, total: 10_000 },
      memoryUsedBytes: 2_000,
      memoryTotalBytes: 8_000,
      diskUsedBytes: 20_000,
      diskTotalBytes: 100_000,
      networkRxBytes: 10_000,
      networkTxBytes: 4_000
    },
    {
      cpu: { idle: 4_200, total: 11_000 },
      memoryUsedBytes: 2_500,
      memoryTotalBytes: 8_000,
      diskUsedBytes: 21_000,
      diskTotalBytes: 100_000,
      networkRxBytes: 1_010_000,
      networkTxBytes: 504_000
    }
  ];
  const timestamps = [1_000, 2_000];
  const collector = new NodeTelemetryCollector({
    sampleProvider: async () => samples.shift(),
    serviceProvider: async () => "running",
    clock: () => timestamps.shift()
  });

  const initial = await collector.collect();
  const current = await collector.collect();

  assert.equal(initial.networkRxBps, 0);
  assert.equal(current.cpuPercent, 80);
  assert.equal(current.memoryUsedBytes, 2_500);
  assert.equal(current.memoryTotalBytes, 8_000);
  assert.equal(current.diskUsedBytes, 21_000);
  assert.equal(current.diskTotalBytes, 100_000);
  assert.equal(current.networkRxBps, 8_000_000);
  assert.equal(current.networkTxBps, 4_000_000);
  assert.equal(current.serviceStatus, "running");
});

test("node runtime restores the previous config when systemd rejects a publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-rollback-"));
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "config.json");
  await writeFile(configPath, "{\"version\":\"previous\"}\n");
  const commands = [];
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    commandRunner: async (command, args) => {
      commands.push([command, ...args]);
      if (command === "systemctl" && commands.filter(([name]) => name === "systemctl").length === 1) {
        throw new Error("service failed to start");
      }
      return { stdout: "sing-box version 1.13.12\n", stderr: "" };
    }
  });

  await assert.rejects(
    adapter.publish({ configText: "{\"version\":\"candidate\"}", version: 2, checksum: "sha256:candidate" }),
    /service failed to start/
  );
  assert.equal(await readFile(configPath, "utf8"), "{\"version\":\"previous\"}\n");
  assert.equal(commands.filter(([command]) => command === "systemctl").length, 2);
});

test("node publication exposes rollback failure when both candidate and previous service fail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-rollback-failed-"));
  const configPath = join(directory, "config.json");
  await writeFile(configPath, '{"version":"previous"}\n');
  let restarts = 0;
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    commandRunner: async (command) => {
      if (command === "systemctl") throw new Error(++restarts === 1 ? "candidate failed" : "previous failed");
      return { stdout: "", stderr: "" };
    }
  });
  await assert.rejects(adapter.publish({ configText: '{"version":"candidate"}', version: "v2" }), (error) => {
    assert.equal(error.message, "candidate failed");
    assert.equal(error.rolledBack, false);
    assert.equal(error.rollbackError, "previous failed");
    return true;
  });
  assert.equal(await readFile(configPath, "utf8"), '{"version":"previous"}\n');
  assert.equal(restarts, 2);
});

test("first Node publication stops a candidate rejected by its activation check", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-stop-first-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let running = false;
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    portVerifier: { waitForListening: async () => { throw new Error("activation check failed"); } },
    commandRunner: async (command, args) => {
      if (command !== "systemctl") return { stdout: "" };
      if (args[0] === "restart") { running = true; return { stdout: "" }; }
      if (args[0] === "stop") { running = false; return { stdout: "" }; }
      // runCommand preserves execFile output in cause when wrapping an error.
      throw Object.assign(new Error("inactive"), { code: 3, cause: { stdout: "inactive\n" } });
    }
  });
  await assert.rejects(adapter.publish({ version: "first", configText: '{"inbounds":[]}', activation: { exposure: "local" } }), (error) => {
    assert.equal(error.message, "activation check failed");
    assert.equal(error.rolledBack, true);
    assert.equal(running, false, "the rejected candidate must no longer serve traffic");
    return true;
  });
  await assert.rejects(readFile(join(directory, "config.json")), { code: "ENOENT" });
});

for (const failure of ["stop-failed", "still-active", "status-unavailable"]) {
  test(`first Node publication reports failed rollback when ${failure}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "raylink-node-stop-failed-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const adapter = new NodeRuntimeAdapter({
      dataDir: directory,
      portVerifier: { waitForListening: async () => { throw new Error("activation check failed"); } },
      commandRunner: async (command, args) => {
        if (command !== "systemctl" || args[0] === "restart") return { stdout: "" };
        if (args[0] === "stop") {
          if (failure === "stop-failed") throw new Error("stop denied");
          return { stdout: "" };
        }
        if (failure === "status-unavailable") throw Object.assign(new Error("status unavailable"), { code: 1 });
        return { stdout: "active\n" };
      }
    });
    await assert.rejects(adapter.publish({ version: "first", configText: '{"inbounds":[]}', activation: { exposure: "local" } }), (error) => {
      assert.equal(error.message, "activation check failed");
      assert.equal(error.rolledBack, false);
      assert.match(error.rollbackError, /stop denied|active|status unavailable/);
      return true;
    });
  });
}

test("node runtime removes a first config when the service cannot start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-first-failure-"));
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    commandRunner: async (command) => {
      if (command === "systemctl") throw new Error("service failed to start");
      return { stdout: "sing-box version 1.13.12\n", stderr: "" };
    }
  });

  await assert.rejects(
    adapter.publish({ configText: "{\"version\":\"candidate\"}", version: 1, checksum: "sha256:candidate" }),
    /service failed to start/
  );
  await assert.rejects(access(join(directory, "config.json")), { code: "ENOENT" });
});
