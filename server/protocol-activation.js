import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual, promisify } from "node:util";

import {
  protocolAvailability,
  protocolCatalog
} from "./singbox/protocol-catalog.js";

const execFile = promisify(execFileCallback);

const policies = new Map([
  ["shadowsocks", { group: "one-click", network: "tcp", exposure: "public", tls: "none" }],
  ["vmess", { group: "one-click", network: "tcp", exposure: "public", tls: "managed-certificate" }],
  ["vless", { group: "one-click", network: "tcp", exposure: "public", tls: "managed-certificate" }],
  ["trojan", { group: "tls", network: "tcp", exposure: "public", tls: "managed-certificate" }],
  ["naive", { group: "tls", network: "tcp", exposure: "public", tls: "managed-certificate" }],
  ["anytls", { group: "tls", network: "tcp", exposure: "public", tls: "managed-certificate" }],
  ["hysteria", { group: "udp-tls", network: "udp", exposure: "public", tls: "managed-certificate" }],
  ["tuic", { group: "udp-tls", network: "udp", exposure: "public", tls: "managed-certificate" }],
  ["hysteria2", { group: "udp-tls", network: "udp", exposure: "public", tls: "managed-certificate" }],
  ["socks", { group: "private", network: "tcp", exposure: "private", tls: "none" }],
  ["http", { group: "private", network: "tcp", exposure: "private", tls: "none" }],
  ["mixed", { group: "private", network: "tcp", exposure: "private", tls: "none" }],
  ["shadowtls", { group: "advanced", network: "tcp", exposure: "advanced", tls: "manual" }],
  ["direct", { group: "advanced", network: "tcp", exposure: "advanced", tls: "manual" }],
  ["tun", { group: "advanced", network: "system", exposure: "advanced", tls: "manual" }],
  ["redirect", { group: "advanced", network: "tcp", exposure: "advanced", tls: "manual" }],
  ["tproxy", { group: "advanced", network: "tcp", exposure: "advanced", tls: "manual" }]
]);

function activationError(code, message, statusCode = 422) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

const PROTOCOL_CONNECTION_SAMPLE_COUNT = 5;
const PROTOCOL_CONNECTION_MINIMUM_SUCCESSES = 4;
const PROTOCOL_HEALTH_WINDOW_ROUNDS = 12;

function measurementFingerprint(host, configuredProfiles, type) {
  if (!host) return null;
  const appliedProfiles = host.appliedProtocols?.length ? host.appliedProtocols : configuredProfiles;
  return createHash("sha256").update(JSON.stringify({
    address: host.address,
    configured: configuredProfiles.find((profile) => profile.type === type),
    applied: appliedProfiles.find((profile) => profile.type === type)
  })).digest("hex");
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function connectionJitter(values) {
  if (values.length < 2) return 0;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function updateHealthWindow(previousCheck, samples, checkedAt, metrics = {}) {
  const previousRounds = Array.isArray(previousCheck?.healthWindow?.rounds)
    ? previousCheck.healthWindow.rounds
    : [];
  const rounds = [
    ...previousRounds,
    {
      checkedAt,
      count: samples.count,
      successful: samples.successful,
      failed: samples.failed,
      ...(Number.isFinite(metrics.latencyMs) ? { latencyMs: metrics.latencyMs } : {}),
      ...(Number.isFinite(metrics.p95Ms) ? { p95Ms: metrics.p95Ms } : {}),
      ...(Number.isFinite(metrics.jitterMs) ? { jitterMs: metrics.jitterMs } : {})
    }
  ].slice(-PROTOCOL_HEALTH_WINDOW_ROUNDS);
  const totals = rounds.reduce((summary, round) => ({
    count: summary.count + Number(round.count || 0),
    successful: summary.successful + Number(round.successful || 0),
    failed: summary.failed + Number(round.failed || 0)
  }), { count: 0, successful: 0, failed: 0 });
  return {
    rounds,
    ...totals,
    successRate: totals.count ? Math.round(totals.successful / totals.count * 10_000) / 100 : 0
  };
}

function protocolHealthLayers({ reachable, probe, previousState = "" }) {
  const fullProtocolProbe = probe === "sing-box-tools-fetch";
  const passed = reachable === true;
  const failed = reachable === false;
  return {
    port: passed
      ? "passed"
      : ["port-listening", "public-ready"].includes(previousState)
        ? "last-known"
        : "unknown",
    handshake: fullProtocolProbe
      ? passed ? "passed" : failed ? "failed" : "unknown"
      : "not-measured",
    public: passed ? "passed" : failed ? "failed" : "unknown"
  };
}

export function protocolActivationPolicy(type) {
  const policy = policies.get(type);
  if (!policy) throw activationError("PROTOCOL_NOT_FOUND", "sing-box 入站协议不存在", 404);
  return { ...policy };
}

function isDomain(value) {
  return Boolean(value)
    && net.isIP(value) === 0
    && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
}

function listenHostForProbe(listen) {
  if (listen === "::" || listen === "0.0.0.0") return "127.0.0.1";
  return listen;
}

function waitForSocket(socket, timeoutMs, onReady) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try {
        socket.close?.();
      } catch {}
      try {
        socket.destroy?.();
      } catch {}
      reject(new Error("端口操作超时"));
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    onReady(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function tcpPortAvailable(host, port) {
  const server = net.createServer();
  try {
    await waitForSocket(server, 2_000, (ready) => {
      server.listen({ host, port, exclusive: true }, ready);
    });
    return true;
  } catch (error) {
    if (error.code === "EADDRINUSE" || error.code === "EACCES") return false;
    throw error;
  } finally {
    await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
  }
}

async function udpPortAvailable(host, port) {
  const family = host.includes(":") ? "udp6" : "udp4";
  const socket = dgram.createSocket(family);
  try {
    await waitForSocket(socket, 2_000, (ready) => {
      socket.bind({ address: host, port, exclusive: true }, ready);
    });
    return true;
  } catch (error) {
    if (error.code === "EADDRINUSE" || error.code === "EACCES") return false;
    throw error;
  } finally {
    try {
      socket.close();
    } catch {}
  }
}

export class LocalPortManager {
  async available({ listen, port, network }) {
    return network === "udp"
      ? udpPortAvailable(listen, port)
      : tcpPortAvailable(listen, port);
  }

  async findAvailable({ preferredPort, listen, network, usedPorts = [] }) {
    const reserved = new Set(usedPorts);
    for (let offset = 0; offset <= 200; offset += 1) {
      const port = preferredPort + offset;
      if (port > 65_535 || reserved.has(port)) continue;
      if (await this.available({ listen, port, network })) return port;
    }
    throw activationError(
      "NO_AVAILABLE_PROTOCOL_PORT",
      `从 ${preferredPort} 开始未找到可用的 ${network.toUpperCase()} 端口`,
      409
    );
  }

  async waitForListening({ listen, port, network, timeoutMs = 8_000 }) {
    const deadline = Date.now() + timeoutMs;
    const host = listenHostForProbe(listen);
    while (Date.now() < deadline) {
      if (network === "udp") {
        if (!await udpPortAvailable(listen, port)) return true;
      } else {
        try {
          await new Promise((resolve, reject) => {
            const socket = net.connect({ host, port });
            socket.setTimeout(1_000);
            socket.once("connect", () => {
              socket.destroy();
              resolve();
            });
            socket.once("timeout", () => {
              socket.destroy();
              reject(new Error("timeout"));
            });
            socket.once("error", reject);
          });
          return true;
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw activationError("PROTOCOL_NOT_LISTENING", `端口 ${port}/${network} 未开始监听`, 502);
  }
}

export class UfwFirewallManager {
  constructor({ commandRunner = execFile, enabled = true } = {}) {
    this.commandRunner = commandRunner;
    this.enabled = enabled;
  }

  async open({ port, network }) {
    if (!this.enabled) return { managed: false, rollback: async () => {} };
    let status;
    try {
      status = await this.commandRunner("ufw", ["status"]);
    } catch (error) {
      if (error.code === "ENOENT") return { managed: false, rollback: async () => {} };
      throw error;
    }
    if (!/^Status:\s+active/im.test(String(status.stdout || ""))) {
      return { managed: false, rollback: async () => {} };
    }
    const rule = `${port}/${network}`;
    if (
      String(status.stdout || "").split("\n").some((line) => (
        new RegExp(`^\\s*${port}\\/${network}\\s+ALLOW\\b`, "i").test(line)
      ))
    ) {
      return { managed: false, preexisting: true, rule, rollback: async () => {} };
    }
    await this.commandRunner("ufw", ["allow", rule, "comment", "RayLink managed"]);
    return {
      managed: true,
      rule,
      rollback: async () => {
        await this.commandRunner("ufw", ["--force", "delete", "allow", rule]);
      }
    };
  }
}

export class PublicConnectivityProbe {
  async verify({ address, port, network, timeoutMs = 5_000 }) {
    if (network === "udp") {
      return {
        reachable: null,
        reason: "UDP 公网握手需要协议级外部探针；已完成本机监听与防火墙验证"
      };
    }
    const startedAt = performance.now();
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: address, port });
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("timeout", () => {
        socket.destroy();
        reject(activationError("PUBLIC_PORT_UNREACHABLE", `公网端口 ${address}:${port} 连接超时`, 502));
      });
      socket.once("error", (error) => {
        reject(activationError(
          "PUBLIC_PORT_UNREACHABLE",
          `公网端口 ${address}:${port} 不可达：${error.message}`,
          502
        ));
      });
    });
    return {
      reachable: true,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      probe: "tcp-connect"
    };
  }
}

export class ProtocolActivationManager {
  constructor({
    store,
    runtimeManager,
    installer,
    portManager = new LocalPortManager(),
    firewallManager = new UfwFirewallManager(),
    publicProbe = new PublicConnectivityProbe(),
    protocolProbe = null,
    certificateEmail = () => "",
    certificateProvider = null,
    certificateStager = null,
    randomBytes = cryptoRandomBytes,
    runtimeMode = "systemd"
  }) {
    this.store = store;
    this.runtimeManager = runtimeManager;
    this.installer = installer;
    this.portManager = portManager;
    this.firewallManager = firewallManager;
    this.publicProbe = publicProbe;
    this.protocolProbe = protocolProbe;
    this.certificateEmail = certificateEmail;
    this.certificateProvider = certificateProvider;
    this.certificateStager = certificateStager;
    this.randomBytes = randomBytes;
    this.runtimeMode = runtimeMode;
    this.activating = new Set();
    this.measuring = new Set();
  }

  record(hostId, type, state, extra = {}) {
    return this.store.setProtocolActivation(hostId, type, {
      state,
      updatedAt: new Date().toISOString(),
      ...extra
    });
  }

  async probePublicProtocol({
    type,
    address,
    port,
    network,
    serverConfig = null,
    attempts,
    timeoutMs
  }) {
    if (this.protocolProbe) {
      return this.protocolProbe({
        type,
        address,
        port,
        network,
        ...(serverConfig ? { serverConfig } : {}),
        ...(attempts ? { attempts } : {}),
        ...(timeoutMs ? { timeoutMs } : {})
      });
    }
    return this.publicProbe.verify({ address, port, network });
  }

  async installationFor(host) {
    if (host.id === "local") return this.installer.status();
    return host.runtimeVersion
      ? {
          installed: true,
          version: host.runtimeVersion,
          platform: host.platform,
          tags: host.buildTags
        }
      : null;
  }

  async assertAvailable(host, type) {
    const catalog = protocolCatalog.find((entry) => entry.type === type);
    const installation = await this.installationFor(host);
    if (!installation) {
      throw activationError(
        "HOST_CAPABILITIES_UNKNOWN",
        "远程主机尚未上报 sing-box 能力，请先完成 RayLink Node 接入",
        409
      );
    }
    const availability = protocolAvailability(catalog, installation);
    if (!availability.available) {
      throw activationError(
        "PROTOCOL_UNAVAILABLE",
        !availability.versionSupported
          ? `RayLink 当前协议 schema 支持 sing-box 1.13.x / 1.14.x，检测到 ${installation.version || "未知版本"}`
          : availability.platformSupported
            ? `当前 sing-box 构建缺少 ${availability.missingTags.join(", ") || "所需能力"}`
            : `当前平台不支持 ${catalog.name}`
      );
    }
    return { catalog, availability, installation };
  }

  async prepareLocalCertificate(domain) {
    const source = await this.certificateProvider(domain);
    if (!source || !this.certificateStager) return source;
    let staged;
    try {
      staged = await this.certificateStager({
        domain,
        certificatePath: source.certificatePath,
        keyPath: source.keyPath
      });
    } catch (error) {
      if (source.rollback) {
        try {
          await source.rollback();
        } catch (rollbackError) {
          error.rollbackError = `证书签发：${rollbackError.message}`;
        }
      }
      throw error;
    }
    return {
      ...source,
      ...staged,
      rollback: async () => {
        const failures = [];
        for (const [label, action] of [
          ["Runtime TLS 资产", staged.rollback],
          ["Caddy 证书", source.rollback]
        ]) {
          if (!action) continue;
          try {
            await action();
          } catch (error) {
            failures.push(`${label}：${error.message}`);
          }
        }
        if (failures.length) throw new Error(failures.join("；"));
      }
    };
  }

  async measureHost({ hostId }) {
    if (this.measuring.has(hostId)) {
      throw activationError(
        "PROTOCOL_LATENCY_IN_PROGRESS",
        "该主机正在测试协议连接",
        409
      );
    }
    this.measuring.add(hostId);
    try {
      const host = this.store.getHost(hostId);
      if (!host) throw activationError("HOST_NOT_FOUND", "主机不存在", 404);
      const configuredProfiles = this.store.listHostProtocolConfigs(hostId);
      const appliedProfiles = host.appliedProtocols?.length
        ? host.appliedProtocols
        : configuredProfiles;
      const profiles = appliedProfiles.filter((profile) => profile.enabled);
      const fingerprints = new Map(profiles.map((profile) => [
        profile.type, measurementFingerprint(host, configuredProfiles, profile.type)
      ]));
      const configurationUnchanged = (type) => {
        const currentHost = this.store.getHost(hostId);
        return currentHost && measurementFingerprint(
          currentHost, this.store.listHostProtocolConfigs(hostId), type
        ) === fingerprints.get(type);
      };
      const skipped = (type) => ({ type, status: "skipped", reason: "configuration-changed", retryable: true });
      const serverConfig = typeof this.runtimeManager.compileHostRuntimeConfig === "function"
        ? this.runtimeManager.compileHostRuntimeConfig(hostId, appliedProfiles)
        : null;
      const existingActivations = new Map(
        (host.protocolActivations || []).map((activation) => [activation.type, activation])
      );
      const checkedAt = new Date().toISOString();
      const results = [];
      for (const profile of profiles) {
        if (!isDeepStrictEqual(profile, configuredProfiles.find((entry) => entry.type === profile.type))
          || !configurationUnchanged(profile.type)) {
          results.push(skipped(profile.type));
          continue;
        }
        const policy = protocolActivationPolicy(profile.type);
        if (policy.exposure !== "public" || !profile.port) {
          const unsupportedReason = policy.exposure === "private"
            ? "仅本机协议不执行公网延迟测试"
            : policy.exposure === "advanced"
              ? "高级系统协议不提供独立节点延迟"
              : "协议没有可探测端口";
          const publicCheck = {
            reachable: null,
            latencyMs: null,
            checkedAt,
            unsupported: true,
            reason: unsupportedReason
          };
          const existing = existingActivations.get(profile.type);
          this.store.setProtocolActivation(hostId, profile.type, {
            ...(existing || {}),
            state: existing?.state || "port-listening",
            port: profile.port || null,
            network: policy.network,
            publicCheck,
            updatedAt: checkedAt
          });
          results.push({
            type: profile.type,
            status: "unsupported",
            latencyMs: null
          });
          continue;
        }
        const existing = existingActivations.get(profile.type);
        let publicCheck;
        let result;
        const latencies = [];
        let lastProbe = null;
        let lastError = null;
        try {
          for (let sample = 0; sample < PROTOCOL_CONNECTION_SAMPLE_COUNT; sample += 1) {
            try {
              const probe = await this.probePublicProtocol({
                type: profile.type,
                address: host.address,
                port: profile.port,
                network: policy.network,
                serverConfig,
                attempts: 1,
                timeoutMs: 10_000
              });
              lastProbe = probe;
              if (probe.reachable === true && Number.isFinite(Number(probe.latencyMs))) {
                latencies.push(Math.max(0, Math.round(Number(probe.latencyMs))));
              } else {
                lastError = new Error("协议连接测试未返回有效耗时");
              }
            } catch (error) {
              lastError = error;
            }
          }
          if (latencies.length < PROTOCOL_CONNECTION_MINIMUM_SUCCESSES) {
            throw lastError || new Error(
              `有效连接样本不足 ${PROTOCOL_CONNECTION_MINIMUM_SUCCESSES} 次`
            );
          }
          const latencyMs = median(latencies);
          const p95Ms = percentile(latencies, 0.95);
          const jitterMs = connectionJitter(latencies);
          const sampleSummary = {
            count: PROTOCOL_CONNECTION_SAMPLE_COUNT,
            successful: latencies.length,
            failed: PROTOCOL_CONNECTION_SAMPLE_COUNT - latencies.length,
            minMs: Math.min(...latencies),
            maxMs: Math.max(...latencies)
          };
          publicCheck = {
            ...lastProbe,
            reachable: true,
            latencyMs,
            p95Ms,
            jitterMs,
            samples: sampleSummary,
            healthWindow: updateHealthWindow(
              existing?.publicCheck,
              sampleSummary,
              checkedAt,
              { latencyMs, p95Ms, jitterMs }
            ),
            layers: protocolHealthLayers({
              reachable: true,
              probe: lastProbe?.probe,
              previousState: existing?.state
            }),
            consecutiveFailures: 0,
            availability: "available",
            lastSuccessAt: checkedAt,
            checkedAt
          };
          result = {
            type: profile.type,
            status: "available",
            latencyMs,
            jitterMs,
            sampleCount: sampleSummary.count,
            successfulSamples: sampleSummary.successful
          };
        } catch (error) {
          const timedOut = /tim(?:e|ed)[ -]?out|超时/i.test(
            `${error.code || ""} ${error.message || ""}`
          );
          const previousCheck = existing?.publicCheck || {};
          const consecutiveFailures = Math.max(
            0,
            Number(previousCheck.consecutiveFailures || 0)
          ) + 1;
          const confirmedFailure = consecutiveFailures >= 3;
          const sampleSummary = {
            count: PROTOCOL_CONNECTION_SAMPLE_COUNT,
            successful: latencies.length,
            failed: PROTOCOL_CONNECTION_SAMPLE_COUNT - latencies.length,
            minMs: latencies.length ? Math.min(...latencies) : null,
            maxMs: latencies.length ? Math.max(...latencies) : null
          };
          publicCheck = {
            ...previousCheck,
            reachable: confirmedFailure
              ? false
              : previousCheck.reachable === true
                ? true
                : null,
            availability: confirmedFailure ? "unavailable" : "degraded",
            consecutiveFailures,
            lastSuccessAt: previousCheck.lastSuccessAt
              || (previousCheck.reachable === true ? previousCheck.checkedAt : null),
            samples: sampleSummary,
            healthWindow: updateHealthWindow(previousCheck, sampleSummary, checkedAt),
            layers: protocolHealthLayers({
              reachable: confirmedFailure ? false : null,
              probe: lastProbe?.probe || (this.protocolProbe ? "sing-box-tools-fetch" : ""),
              previousState: existing?.state
            }),
            checkedAt,
            error: String(error.message || "协议探测失败").slice(0, 300)
          };
          result = {
            type: profile.type,
            status: confirmedFailure
              ? timedOut ? "timeout" : "unreachable"
              : "degraded",
            latencyMs: Number.isFinite(Number(previousCheck.latencyMs))
              ? Number(previousCheck.latencyMs)
              : null,
            jitterMs: Number.isFinite(Number(previousCheck.jitterMs))
              ? Number(previousCheck.jitterMs)
              : null,
            sampleCount: PROTOCOL_CONNECTION_SAMPLE_COUNT,
            successfulSamples: sampleSummary.successful
          };
        }
        // A probe may finish after an edit invalidated its evidence. Never revive it.
        if (!configurationUnchanged(profile.type)) {
          results.push(skipped(profile.type));
          continue;
        }
        this.store.setProtocolActivation(hostId, profile.type, {
          ...(existing || {}),
          state: existing?.state || "port-listening",
          port: profile.port,
          network: policy.network,
          publicCheck,
          updatedAt: checkedAt
        });
        results.push(result);
      }
      return { hostId, checkedAt, results };
    } finally {
      this.measuring.delete(hostId);
    }
  }

  async prepare(host, type, policy, catalog, profiles) {
    const current = profiles.find((profile) => profile.type === type);
    if (!current) throw activationError("PROTOCOL_NOT_FOUND", "sing-box 入站协议不存在", 404);
    const listen = policy.exposure === "private" ? "127.0.0.1"
      : net.isIP(host.address) === 4 ? "0.0.0.0" : "::";
    const usedPorts = profiles
      .filter((profile) => profile.type !== type && profile.enabled && profile.port)
      .map((profile) => profile.port);
    const lastActivation = host.protocolActivations?.find((item) => item.type === type);
    const preferredPort = lastActivation?.errorCode === "PROTOCOL_PORT_OCCUPIED"
      && Number.isInteger(lastActivation.suggestedPort)
      ? lastActivation.suggestedPort
      : current.port || catalog.defaultPort;
    const port = catalog.portless
      ? null
      : host.kind === "remote"
        ? (() => {
            const reserved = new Set(usedPorts);
            for (let offset = 0; offset <= 200; offset += 1) {
              const candidate = preferredPort + offset;
              if (candidate <= 65_535 && !reserved.has(candidate)) return candidate;
            }
            throw activationError(
              "NO_AVAILABLE_PROTOCOL_PORT",
              `从 ${preferredPort} 开始未找到可用的 ${policy.network.toUpperCase()} 端口`,
              409
            );
          })()
        : await this.portManager.findAvailable({
            preferredPort,
            listen,
            network: policy.network,
            usedPorts
          });
    const tls = { ...current.tls, mode: "none" };
    if (policy.tls === "reality") {
      const keypair = await this.installer.generateRealityKeypair();
      Object.assign(tls, {
        mode: "reality",
        serverName: "www.microsoft.com",
        handshakeServer: "www.microsoft.com",
        handshakePort: 443,
        privateKey: keypair.privateKey,
        publicKey: keypair.publicKey,
        shortId: this.randomBytes(8).toString("hex")
      });
    } else if (policy.tls === "managed-certificate") {
      const email = String(this.certificateEmail() || "").trim();
      if (!isDomain(host.address)) {
        throw activationError(
          "NODE_DOMAIN_REQUIRED",
          `${catalog.name} 自动证书需要先为该节点设置已解析的独立域名`
        );
      }
      if (!email) {
        throw activationError(
          "ACME_EMAIL_REQUIRED",
          `${catalog.name} 自动证书需要先在“系统 → 证书”中填写证书通知邮箱`
        );
      }
      if (host.kind === "local" && this.certificateProvider) {
        const certificate = await this.prepareLocalCertificate(host.address);
        if (certificate) {
          Object.assign(tls, {
            mode: "certificate",
            serverName: certificate.serverName || host.address,
            certificatePath: certificate.certificatePath,
            keyPath: certificate.keyPath
          });
          return {
            candidate: {
              ...current,
              enabled: true,
              listen,
              port,
              tls
            },
            certificate
          };
        }
      }
      Object.assign(tls, {
        mode: "acme",
        serverName: host.address,
        acmeEmail: email
      });
    }
    return {
      candidate: {
        ...current,
        enabled: true,
        listen,
        port,
        tls
      },
      certificate: null
    };
  }

  async enable({ hostId, type, adminId = null }) {
    const key = `${hostId}:${type}`;
    if (this.activating.has(key)) {
      throw activationError("PROTOCOL_ACTIVATION_IN_PROGRESS", "该协议正在配置中", 409);
    }
    this.activating.add(key);
    let original;
    const firewalls = [];
    let certificate = null;
    let published = false;
    try {
      const host = this.store.getHost(hostId);
      if (!host) throw activationError("HOST_NOT_FOUND", "主机不存在", 404);
      const policy = protocolActivationPolicy(type);
      if (policy.group === "advanced") {
        throw activationError(
          "PROTOCOL_ADVANCED_ONLY",
          "该协议涉及系统网络或协议编排，只能在高级配置中手动启用"
        );
      }
      const { catalog, availability, installation } = await this.assertAvailable(host, type);
      if (policy.tls === "reality" && !availability.realityAvailable) {
        throw activationError(
          "REALITY_UNAVAILABLE",
          "当前 sing-box 构建缺少 Reality 所需的 with_utls"
        );
      }
      const profiles = this.store.listHostProtocolConfigs(hostId);
      original = structuredClone(profiles.find((profile) => profile.type === type));
      this.record(hostId, type, "configuring", { progress: 10 });
      const prepared = await this.prepare(host, type, policy, catalog, profiles);
      const candidate = prepared.candidate;
      certificate = prepared.certificate;
      if (candidate.tls.mode === "acme" && !installation.tags?.includes("with_acme")) {
        throw activationError(
          "ACME_UNAVAILABLE",
          "当前 sing-box 构建缺少自动证书所需的 with_acme"
        );
      }
      const saved = this.store.updateHostProtocolConfig(hostId, type, candidate);
      const challengePorts = saved.tls.mode === "acme"
        ? [
            { port: 80, network: "tcp", purpose: "acme-http-01" },
            { port: 443, network: "tcp", purpose: "acme-tls-alpn-01" }
          ]
        : [];
      this.record(hostId, type, "pending-publish", { progress: 35, port: saved.port });

      if (host.kind === "remote") {
        const deployment = await this.runtimeManager.publish(adminId, {
          activation: {
            hostId,
            type,
            network: policy.network,
            exposure: policy.exposure,
            address: host.address,
            port: saved.port,
            listen: saved.listen,
            challengePorts,
            previousProfile: original
          }
        });
        this.record(hostId, type, "deploying", {
          progress: 60,
          port: saved.port,
          deploymentId: deployment.id
        });
        return {
          profile: saved,
          deployment,
          activation: {
            state: "deploying",
            asynchronous: true,
            port: saved.port,
            network: policy.network
          }
        };
      }

      if (policy.exposure === "public") {
        for (const rule of [
          { port: saved.port, network: policy.network },
          ...challengePorts
        ]) {
          firewalls.push(await this.firewallManager.open(rule));
        }
      }
      this.record(hostId, type, "deploying", { progress: 60, port: saved.port });
      const deployment = await this.runtimeManager.publish(adminId, {
        reason: "one-click-protocol-activation"
      });
      published = true;
      if (this.runtimeMode !== "dry-run") {
        await this.portManager.waitForListening({
          listen: saved.listen,
          port: saved.port,
          network: policy.network
        });
      }
      this.record(hostId, type, "port-listening", { progress: 85, port: saved.port });
      let publicCheck = { reachable: null, reason: "仅本机协议不执行公网探测" };
      if (policy.exposure === "public" && this.runtimeMode !== "dry-run") {
        publicCheck = await this.probePublicProtocol({
          type,
          address: host.address,
          port: saved.port,
          network: policy.network
        });
      } else if (policy.exposure === "public") {
        publicCheck = { reachable: true, simulated: true };
      }
      publicCheck = {
        ...publicCheck,
        layers: protocolHealthLayers({
          reachable: publicCheck.reachable,
          probe: publicCheck.probe,
          previousState: "port-listening"
        }),
        checkedAt: publicCheck.checkedAt || new Date().toISOString()
      };
      const state = publicCheck.reachable === true ? "public-ready" : "port-listening";
      const activation = this.record(hostId, type, state, {
        progress: 100,
        port: saved.port,
        network: policy.network,
        firewallManaged: firewalls.some((item) => item.managed === true),
        publicCheck
      });
      return { profile: saved, deployment, activation };
    } catch (error) {
      const rollbackFailures = [];
      if (original) {
        try {
          this.store.updateHostProtocolConfig(hostId, type, original);
          if (published) {
            await this.runtimeManager.publish(adminId, {
              reason: "one-click-protocol-rollback"
            });
          }
        } catch (rollbackError) {
          rollbackFailures.push(`配置：${rollbackError.message}`);
        }
      }
      for (const firewall of firewalls.reverse()) {
        try {
          await firewall.rollback();
        } catch (rollbackError) {
          rollbackFailures.push(`防火墙：${rollbackError.message}`);
        }
      }
      if (certificate?.rollback) {
        try {
          await certificate.rollback();
        } catch (rollbackError) {
          rollbackFailures.push(`证书：${rollbackError.message}`);
        }
      }
      if (rollbackFailures.length) error.rollbackError = rollbackFailures.join("；");
      if (original) {
        this.record(hostId, type, "failed", {
          progress: 100,
          error: error.message,
          rolledBack: !error.rollbackError,
          ...(error.rollbackError ? { rollbackError: error.rollbackError } : {})
        });
      }
      throw error;
    } finally {
      this.activating.delete(key);
    }
  }
}
