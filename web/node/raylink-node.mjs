#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import {
  createHash,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomUUID,
  X509Certificate
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  statfs,
  writeFile
} from "node:fs/promises";
import { arch, cpus, freemem, hostname, platform, totalmem } from "node:os";
import { connect as connectHttp2 } from "node:http2";
import { connect as connectTcp } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const AGENT_VERSION = "0.8.0";
const SECRET_ENVELOPE_ALGORITHM = "x25519-hkdf-sha256-aes-256-gcm";
const SECRET_ENVELOPE_CONTEXT = Buffer.from("raylink-node-secret-v1", "utf8");
const PROTOCOL_PROBE_TYPES = new Set([
  "shadowsocks",
  "vmess",
  "vless",
  "trojan",
  "naive",
  "anytls",
  "hysteria",
  "tuic",
  "hysteria2"
]);
const DEFAULT_PROTOCOL_PROBE_URL = "https://www.gstatic.com/generate_204";

function realityPublicKey(privateKey) {
  const raw = Buffer.from(String(privateKey || ""), "base64url");
  if (raw.length !== 32) throw new Error("Reality 探针私钥无效");
  const prefix = Buffer.from("302e020100300506032b656e04220420", "hex");
  const key = createPrivateKey({
    key: Buffer.concat([prefix, raw]),
    type: "pkcs8",
    format: "der"
  });
  return createPublicKey(key)
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64url");
}

function applyProbeTls(outbound, inbound) {
  if (inbound.tls?.enabled !== true) return;
  const serverName = inbound.tls.server_name;
  if (!serverName) {
    throw new Error(`${inbound.type} 外部探针缺少 TLS 服务器名称`);
  }
  outbound.tls = { enabled: true, server_name: serverName };
  if (inbound.tls.reality?.enabled === true) {
    outbound.tls.reality = {
      enabled: true,
      public_key: realityPublicKey(inbound.tls.reality.private_key),
      short_id: inbound.tls.reality.short_id?.[0] || ""
    };
    outbound.tls.utls = { enabled: true, fingerprint: "chrome" };
  }
}

export function buildProtocolProbeConfig({ activation, configText }) {
  const serverConfig = JSON.parse(configText);
  if (!PROTOCOL_PROBE_TYPES.has(activation.type)) {
    throw new Error(`协议 ${activation.type} 不支持外部握手探针`);
  }
  const inbound = serverConfig.inbounds?.find((entry) => (
    entry.type === activation.type
    && Number(entry.listen_port) === Number(activation.port)
  ));
  if (!inbound) {
    throw new Error(`找不到 ${activation.type} 的已发布入站配置`);
  }
  const user = inbound.users?.find((entry) => (
    entry.name === "raylink-probe@internal"
    || entry.username === "raylink-probe@internal"
  ))
    || inbound.users?.[0];
  if (!user) {
    throw new Error(`${activation.type} 外部探针需要至少一个有效用户`);
  }
  const common = {
    type: activation.type,
    tag: "raylink-probe",
    server: activation.address,
    server_port: activation.port
  };
  let outbound;
  if (activation.type === "shadowsocks") {
    outbound = {
      ...common,
      method: inbound.method,
      password: `${inbound.password}:${user.password}`
    };
  } else if (activation.type === "vmess") {
    outbound = { ...common, uuid: user.uuid, security: "auto" };
  } else if (activation.type === "vless") {
    outbound = { ...common, uuid: user.uuid };
  } else if (activation.type === "naive") {
    outbound = {
      ...common,
      username: user.username,
      password: user.password
    };
  } else if (activation.type === "hysteria") {
    outbound = {
      ...common,
      auth_str: user.auth_str,
      up_mbps: inbound.up_mbps,
      down_mbps: inbound.down_mbps
    };
  } else if (activation.type === "tuic") {
    outbound = {
      ...common,
      uuid: user.uuid,
      password: user.password,
      congestion_control: "bbr"
    };
  } else {
    outbound = { ...common, password: user.password };
  }
  applyProbeTls(outbound, inbound);
  if (inbound.transport) outbound.transport = structuredClone(inbound.transport);
  return {
    log: { disabled: true },
    dns: {
      servers: [{ type: "local", tag: "raylink-probe-dns" }],
      final: "raylink-probe-dns",
      strategy: "prefer_ipv4"
    },
    outbounds: [outbound],
    route: {
      final: "raylink-probe",
      default_domain_resolver: "raylink-probe-dns"
    }
  };
}

export const buildUdpProtocolProbeConfig = buildProtocolProbeConfig;

function generateEncryptionKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    encryptionPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    encryptionPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

function openSealedBundle(privateKeyPem, envelope) {
  if (envelope?.algorithm !== SECRET_ENVELOPE_ALGORITHM) {
    throw new Error("TLS 资产密封算法不受支持");
  }
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "x25519") {
    throw new Error("RayLink Node 资产私钥无效");
  }
  const publicKey = createPublicKey({
    key: Buffer.from(String(envelope.ephemeralPublicKey || ""), "base64"),
    type: "spki",
    format: "der"
  });
  const shared = diffieHellman({ privateKey, publicKey });
  const key = Buffer.from(hkdfSync(
    "sha256",
    shared,
    Buffer.from(String(envelope.salt || ""), "base64"),
    SECRET_ENVELOPE_CONTEXT,
    32
  ));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(String(envelope.iv || ""), "base64")
  );
  decipher.setAuthTag(Buffer.from(String(envelope.authTag || ""), "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(String(envelope.ciphertext || ""), "base64")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

function protobufVarint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function readProtobufVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    value |= BigInt(byte & 0x7f) << shift;
    cursor += 1;
    if ((byte & 0x80) === 0) return { value, offset: cursor };
    shift += 7n;
  }
  throw new Error("V2Ray Stats protobuf 数据不完整");
}

function skipProtobufField(buffer, offset, wireType) {
  if (wireType === 0) return readProtobufVarint(buffer, offset).offset;
  if (wireType === 1) return offset + 8;
  if (wireType === 5) return offset + 4;
  if (wireType === 2) {
    const length = readProtobufVarint(buffer, offset);
    return length.offset + Number(length.value);
  }
  throw new Error(`V2Ray Stats protobuf wire type ${wireType} 不受支持`);
}

function decodeV2RayStat(buffer) {
  let offset = 0;
  let name = "";
  let value = 0;
  while (offset < buffer.length) {
    const key = readProtobufVarint(buffer, offset);
    offset = key.offset;
    const field = Number(key.value >> 3n);
    const wireType = Number(key.value & 0x7n);
    if (field === 1 && wireType === 2) {
      const length = readProtobufVarint(buffer, offset);
      const end = length.offset + Number(length.value);
      name = buffer.subarray(length.offset, end).toString("utf8");
      offset = end;
    } else if (field === 2 && wireType === 0) {
      const decoded = readProtobufVarint(buffer, offset);
      if (decoded.value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("V2Ray Stats 计数超过安全整数范围");
      }
      value = Number(decoded.value);
      offset = decoded.offset;
    } else {
      offset = skipProtobufField(buffer, offset, wireType);
    }
  }
  return { name, value };
}

function decodeV2RayQueryResponse(buffer) {
  const stats = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readProtobufVarint(buffer, offset);
    offset = key.offset;
    const field = Number(key.value >> 3n);
    const wireType = Number(key.value & 0x7n);
    if (field === 1 && wireType === 2) {
      const length = readProtobufVarint(buffer, offset);
      const end = length.offset + Number(length.value);
      stats.push(decodeV2RayStat(buffer.subarray(length.offset, end)));
      offset = end;
    } else {
      offset = skipProtobufField(buffer, offset, wireType);
    }
  }
  return stats;
}

async function queryV2RayStats(endpoint = "http://127.0.0.1:10085") {
  const session = connectHttp2(new URL(endpoint).origin);
  let timeoutHandle;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let grpcStatus = "0";
    timeoutHandle = setTimeout(() => {
      session.destroy();
      reject(new Error("V2Ray Stats 查询超时"));
    }, 5_000);
    const request = session.request({
      ":method": "POST",
      ":path": "/v2ray.core.app.stats.command.StatsService/QueryStats",
      "content-type": "application/grpc",
      te: "trailers"
    });
    request.on("response", (headers) => {
      if (Number(headers[":status"]) !== 200) {
        reject(new Error(`V2Ray Stats HTTP ${headers[":status"]}`));
      }
      if (headers["grpc-status"] !== undefined) {
        grpcStatus = String(headers["grpc-status"]);
      }
    });
    request.on("trailers", (headers) => {
      grpcStatus = String(headers["grpc-status"] || "0");
    });
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      clearTimeout(timeoutHandle);
      session.close();
      if (grpcStatus !== "0") {
        reject(new Error(`V2Ray Stats gRPC ${grpcStatus}`));
        return;
      }
      try {
        const body = Buffer.concat(chunks);
        const stats = [];
        let offset = 0;
        while (offset + 5 <= body.length) {
          if (body[offset] !== 0) throw new Error("V2Ray Stats 压缩响应不受支持");
          const length = body.readUInt32BE(offset + 1);
          const start = offset + 5;
          const end = start + length;
          if (end > body.length) throw new Error("V2Ray Stats gRPC 帧不完整");
          stats.push(...decodeV2RayQueryResponse(body.subarray(start, end)));
          offset = end;
        }
        resolve(stats);
      } catch (error) {
        reject(error);
      }
    });
    const pattern = Buffer.from("user>>>", "utf8");
    const payload = Buffer.concat([Buffer.from([0x1a]), protobufVarint(pattern.length), pattern]);
    const frame = Buffer.alloc(5);
    frame.writeUInt32BE(payload.length, 1);
    request.end(Buffer.concat([frame, payload]));
  }).finally(() => {
    clearTimeout(timeoutHandle);
    session.close();
  });
}

function normalizeV2RayStats(stats) {
  const users = new Map();
  for (const stat of stats || []) {
    const match = String(stat.name || "").match(/^user>>>(.+)>>>traffic>>>(uplink|downlink)$/);
    if (!match || !Number.isSafeInteger(stat.value) || stat.value < 0) continue;
    const usage = users.get(match[1]) || {
      name: match[1],
      uplinkBytes: 0,
      downlinkBytes: 0
    };
    usage[match[2] === "uplink" ? "uplinkBytes" : "downlinkBytes"] = stat.value;
    users.set(match[1], usage);
  }
  return [...users.values()];
}

export class NodeUsageCollector {
  constructor(options = {}) {
    this.query = options.query || (() => queryV2RayStats(options.endpoint));
    this.instanceProvider = options.instanceProvider || (async () => {
      const { stdout } = await runCommand("systemctl", [
        "show",
        options.systemdUnit || "raylink-sing-box.service",
        "--property=InvocationID",
        "--value"
      ]);
      return String(stdout || "").trim();
    });
    this.clock = options.clock || (() => new Date());
    this.sampleId = options.sampleId || randomUUID;
  }

  async collect() {
    const runtimeInstanceId = String(await this.instanceProvider());
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(runtimeInstanceId)) {
      throw new Error("Runtime 实例编号无效");
    }
    const users = normalizeV2RayStats(await this.query());
    if (String(await this.instanceProvider()) !== runtimeInstanceId) {
      throw new Error("采样期间 Runtime 实例发生变化，等待下一轮重新采样");
    }
    return {
      sampleId: this.sampleId(),
      runtimeInstanceId,
      observedAt: this.clock().toISOString(),
      users
    };
  }
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function removeNewTlsAssets(paths) {
  for (const path of [...paths].reverse()) {
    await rm(path, { force: true });
  }
}

function referencedTlsReleaseDirectories(config, dataDir) {
  const releasesDirectory = resolve(dataDir, "tls", "releases");
  return new Set((config?.inbounds || []).flatMap((inbound) => [
    inbound.tls?.certificate_path,
    inbound.tls?.key_path
  ]).filter(Boolean).flatMap((path) => {
    const directory = dirname(resolve(String(path)));
    return directory.startsWith(`${releasesDirectory}/`) ? [directory] : [];
  }));
}

async function pruneTlsReleases(dataDir, configPaths) {
  const releasesDirectory = resolve(dataDir, "tls", "releases");
  const keep = new Set();
  for (const configPath of configPaths) {
    const config = await readFile(configPath, "utf8")
      .then((value) => JSON.parse(value))
      .catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (config) {
      for (const directory of referencedTlsReleaseDirectories(config, dataDir)) {
        keep.add(directory);
      }
    }
  }
  const entries = await readdir(releasesDirectory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const releasePath = resolve(releasesDirectory, entry.name);
    if (!releasePath.startsWith(`${releasesDirectory}/`) || keep.has(releasePath)) continue;
    await rm(releasePath, { recursive: true, force: true });
  }
}

async function runCommand(command, args, options = {}) {
  try {
    return await execFile(command, args, {
      timeout: options.timeout || 30_000,
      maxBuffer: options.maxBuffer || 1024 * 1024
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    const wrapped = new Error(detail || `${command} 执行失败`);
    wrapped.code = error.code;
    wrapped.cause = error;
    throw wrapped;
  }
}

function cpuTimesSnapshot() {
  return cpus().reduce((totals, cpu) => {
    const times = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    totals.idle += cpu.times.idle;
    totals.total += times;
    return totals;
  }, { idle: 0, total: 0 });
}

async function networkBytesSnapshot() {
  if (platform() !== "linux") return { networkRxBytes: null, networkTxBytes: null };
  try {
    const content = await readFile("/proc/net/dev", "utf8");
    return content.split("\n").slice(2).reduce((totals, line) => {
      const [interfaceName, counters] = line.trim().split(/\s*:\s*/);
      if (!interfaceName || !counters || interfaceName === "lo") return totals;
      const fields = counters.trim().split(/\s+/).map(Number);
      totals.networkRxBytes += Number.isFinite(fields[0]) ? fields[0] : 0;
      totals.networkTxBytes += Number.isFinite(fields[8]) ? fields[8] : 0;
      return totals;
    }, { networkRxBytes: 0, networkTxBytes: 0 });
  } catch {
    return { networkRxBytes: null, networkTxBytes: null };
  }
}

async function systemSample() {
  const memoryTotalBytes = totalmem();
  let disk = { diskUsedBytes: null, diskTotalBytes: null };
  try {
    const filesystem = await statfs("/");
    const diskTotalBytes = Number(filesystem.bsize) * Number(filesystem.blocks);
    const diskAvailableBytes = Number(filesystem.bsize) * Number(filesystem.bavail);
    disk = {
      diskUsedBytes: Math.max(0, diskTotalBytes - diskAvailableBytes),
      diskTotalBytes
    };
  } catch {}
  return {
    cpu: cpuTimesSnapshot(),
    memoryUsedBytes: memoryTotalBytes - freemem(),
    memoryTotalBytes,
    ...disk,
    ...await networkBytesSnapshot()
  };
}

async function serviceState(systemdUnit) {
  if (platform() !== "linux") return "unknown";
  try {
    const { stdout } = await execFile("systemctl", ["is-active", systemdUnit], { timeout: 5_000 });
    return String(stdout).trim() === "active" ? "running" : "stopped";
  } catch (error) {
    return String(error.stdout || "").trim() === "inactive" ? "stopped" : "failed";
  }
}

export class NodeTelemetryCollector {
  constructor(options = {}) {
    this.sampleProvider = options.sampleProvider || systemSample;
    this.serviceProvider = options.serviceProvider
      || (() => serviceState(options.systemdUnit || "raylink-sing-box.service"));
    this.clock = options.clock || Date.now;
    this.previous = null;
  }

  async collect() {
    const sample = await this.sampleProvider();
    const timestamp = this.clock();
    const elapsedSeconds = this.previous
      ? Math.max(0.001, (timestamp - this.previous.timestamp) / 1000)
      : null;
    const cpuTotalDelta = this.previous ? sample.cpu.total - this.previous.sample.cpu.total : 0;
    const cpuIdleDelta = this.previous ? sample.cpu.idle - this.previous.sample.cpu.idle : 0;
    const cpuPercent = cpuTotalDelta > 0
      ? Math.max(0, Math.min(100, ((cpuTotalDelta - cpuIdleDelta) / cpuTotalDelta) * 100))
      : 0;
    const byteRate = (current, previous) => {
      if (
        elapsedSeconds === null
        || !Number.isFinite(current)
        || !Number.isFinite(previous)
        || current < previous
      ) return 0;
      return ((current - previous) * 8) / elapsedSeconds;
    };
    const telemetry = {
      cpuPercent: Number(cpuPercent.toFixed(1)),
      memoryUsedBytes: sample.memoryUsedBytes,
      memoryTotalBytes: sample.memoryTotalBytes,
      diskUsedBytes: sample.diskUsedBytes,
      diskTotalBytes: sample.diskTotalBytes,
      networkRxBytes: sample.networkRxBytes,
      networkTxBytes: sample.networkTxBytes,
      networkRxBps: byteRate(sample.networkRxBytes, this.previous?.sample.networkRxBytes),
      networkTxBps: byteRate(sample.networkTxBytes, this.previous?.sample.networkTxBytes),
      serviceStatus: await this.serviceProvider()
    };
    this.previous = { sample, timestamp };
    return telemetry;
  }
}

export class NodeRuntimeAdapter {
  constructor(options = {}) {
    this.dataDir = options.dataDir || "/var/lib/raylink-node/sing-box";
    this.binaryPath = options.binaryPath || "sing-box";
    this.systemdUnit = options.systemdUnit || "raylink-sing-box.service";
    this.runtimeMode = options.runtimeMode || "systemd";
    this.meteredRuntimeBuilder = options.meteredRuntimeBuilder
      || "/opt/raylink-node/build-metered-runtime.sh";
    this.runtimeArtifactBaseUrl = String(options.runtimeArtifactBaseUrl || "").replace(/\/+$/, "");
    this.runtimeArch = options.runtimeArch || arch();
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.preferMeteredRuntime = options.preferMeteredRuntime === true;
    this.commandRunner = options.commandRunner || runCommand;
    this.healthCheckDelayMs = Math.max(0, Number(options.healthCheckDelayMs ?? 2_000) || 0);
    this.firewallManager = options.firewallManager || {
      open: (activation) => this.openFirewall(activation)
    };
    this.portVerifier = options.portVerifier || {
      assertAvailable: (activation) => this.assertPortAvailable(activation),
      waitForListening: (activation) => this.waitForListening(activation)
    };
    this.publicProbe = options.publicProbe || {
      verify: (activation) => this.verifyPublicConnectivity(activation)
    };
    this.protocolProbe = options.protocolProbe || {
      verify: (activation) => this.verifyProtocol(activation)
    };
    this.protocolProbeUrl = options.protocolProbeUrl || DEFAULT_PROTOCOL_PROBE_URL;
    this.protocolProbeAttempts = Math.max(
      1,
      Number(options.protocolProbeAttempts || 3)
    );
    this.protocolProbeDelayMs = Math.max(
      0,
      Number(options.protocolProbeDelayMs ?? 1_000)
    );
  }

  get configPath() {
    return join(this.dataDir, "config.json");
  }

  async openFirewall({ port, network }) {
    let status;
    try {
      status = await this.commandRunner("ufw", ["status"]);
      if (!/^Status:\s+active/im.test(String(status.stdout || ""))) {
        return { managed: false, rollback: async () => {} };
      }
    } catch (error) {
      if (error.code === "ENOENT" || /not found/i.test(error.message)) {
        return { managed: false, rollback: async () => {} };
      }
      throw error;
    }
    const rule = `${port}/${network}`;
    if (
      String(status.stdout || "").split("\n").some((line) => (
        new RegExp(`^\\s*${port}\\/${network}\\s+ALLOW\\b`, "i").test(line)
      ))
    ) {
      return { managed: false, preexisting: true, rollback: async () => {} };
    }
    await this.commandRunner("ufw", ["allow", rule, "comment", "RayLink managed"]);
    return {
      managed: true,
      rollback: async () => {
        await this.commandRunner("ufw", ["--force", "delete", "allow", rule]);
      }
    };
  }

  async waitForListening({ port, network }) {
    const args = network === "udp" ? ["-H", "-lun"] : ["-H", "-ltn"];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { stdout } = await this.commandRunner("ss", args);
      const listening = String(stdout || "").split("\n").some((line) => (
        new RegExp(`(?:^|\\s|\\]|:)${port}(?=\\s|$)`).test(line)
      ));
      if (listening) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const error = new Error(`端口 ${port}/${network} 未开始监听`);
    error.code = "PROTOCOL_NOT_LISTENING";
    throw error;
  }

  async assertPortAvailable({ port, network }) {
    const args = network === "udp" ? ["-H", "-lun"] : ["-H", "-ltn"];
    const { stdout } = await this.commandRunner("ss", args);
    const occupiedPorts = new Set(
      String(stdout || "").split("\n").flatMap((line) => (
        [...line.matchAll(/:(\d+)(?=\s|$)/g)].map((match) => Number(match[1]))
      ))
    );
    if (!occupiedPorts.has(port)) return true;
    const error = new Error(`端口 ${port}/${network} 已被系统服务占用`);
    error.code = "PROTOCOL_PORT_OCCUPIED";
    for (let candidate = port + 1; candidate <= Math.min(port + 200, 65_535); candidate += 1) {
      if (!occupiedPorts.has(candidate)) {
        error.suggestedPort = candidate;
        break;
      }
    }
    throw error;
  }

  async verifyPublicConnectivity({ address, port, network }) {
    if (network === "udp") {
      return {
        reachable: null,
        reason: "UDP 公网握手需要协议级外部探针；已完成节点监听与防火墙验证"
      };
    }
    const startedAt = performance.now();
    await new Promise((resolve, reject) => {
      const socket = connectTcp({ host: address, port });
      socket.setTimeout(5_000);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("timeout", () => {
        socket.destroy();
        reject(new Error(`公网端口 ${address}:${port} 连接超时`));
      });
      socket.once("error", reject);
    });
    return {
      reachable: true,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      probe: "tcp-connect"
    };
  }

  async verifyProtocol(activation) {
    const probeConfig = buildProtocolProbeConfig({
      activation,
      configText: activation.configText
    });
    const probePath = join(
      this.dataDir,
      `.protocol-probe-${activation.type}-${process.pid}-${Date.now()}.json`
    );
    await writeFile(probePath, `${JSON.stringify(probeConfig, null, 2)}\n`, { mode: 0o600 });
    try {
      await this.commandRunner(this.binaryPath, ["check", "-c", probePath]);
      let lastError = null;
      let latencyMs = null;
      for (let attempt = 1; attempt <= this.protocolProbeAttempts; attempt += 1) {
        try {
          const startedAt = performance.now();
          await this.commandRunner(this.binaryPath, [
            "tools",
            "fetch",
            "-c",
            probePath,
            "-o",
            "raylink-probe",
            this.protocolProbeUrl
          ]);
          latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < this.protocolProbeAttempts && this.protocolProbeDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.protocolProbeDelayMs));
          }
        }
      }
      if (lastError) throw lastError;
      return {
        reachable: true,
        probe: "sing-box-tools-fetch",
        protocol: activation.type,
        target: this.protocolProbeUrl,
        latencyMs
      };
    } catch (error) {
      const wrapped = new Error(
        `${activation.type} 协议握手或外部访问失败：${error.message}`
      );
      wrapped.code = "PROTOCOL_HANDSHAKE_FAILED";
      throw wrapped;
    } finally {
      await rm(probePath, { force: true });
    }
  }

  async installTlsBundle(task, privateKeyPem) {
    if (!task?.sealedTlsBundle) return { count: 0, rollback: async () => {} };
    if (!privateKeyPem) throw new Error("RayLink Node 缺少 TLS 资产解密私钥");
    const bundle = openSealedBundle(privateKeyPem, task.sealedTlsBundle);
    if (!Array.isArray(bundle.assets) || bundle.assets.length < 1 || bundle.assets.length > 32) {
      throw new Error("TLS 资产包内容无效");
    }
    const config = JSON.parse(task.configText);
    const configuredPaths = new Set((config.inbounds || []).flatMap((inbound) => [
      inbound.tls?.certificate_path,
      inbound.tls?.key_path
    ].filter(Boolean)));
    const tlsDirectory = resolve(this.dataDir, "tls");
    await mkdir(tlsDirectory, { recursive: true, mode: 0o700 });
    const createdPaths = [];
    try {
      for (const asset of bundle.assets) {
        const name = String(asset.name || "");
        if (!/^[a-z0-9][a-z0-9_.-]{0,79}$/.test(name)) {
          throw new Error("TLS 资产名称无效");
        }
        const certificatePath = resolve(String(asset.targetCertificatePath || ""));
        const keyPath = resolve(String(asset.targetKeyPath || ""));
        if (!certificatePath.startsWith(`${tlsDirectory}/`) || !keyPath.startsWith(`${tlsDirectory}/`)) {
          throw new Error("TLS 资产目标路径越界");
        }
        if (
          !certificatePath.endsWith(`/${name}.certificate.pem`)
          || !keyPath.endsWith(`/${name}.private-key.pem`)
          || dirname(certificatePath) !== dirname(keyPath)
          || !dirname(certificatePath).startsWith(`${tlsDirectory}/releases/`)
        ) {
          throw new Error("TLS 资产不可变发布路径无效");
        }
        if (!configuredPaths.has(certificatePath) || !configuredPaths.has(keyPath)) {
          throw new Error("TLS 资产与发布配置不匹配");
        }
        const certificatePem = String(asset.certificatePem || "");
        const privateKeyPemValue = String(asset.privateKeyPem || "");
        const certificate = new X509Certificate(certificatePem);
        const certificatePublic = certificate.publicKey.export({ type: "spki", format: "der" });
        const privatePublic = createPublicKey(createPrivateKey(privateKeyPemValue))
          .export({ type: "spki", format: "der" });
        if (!certificatePublic.equals(privatePublic)) {
          throw new Error(`${name} 的 TLS 证书与私钥不匹配`);
        }
        const now = new Date();
        if (new Date(certificate.validFrom) > now || new Date(certificate.validTo) <= now) {
          throw new Error(`${name} 的 TLS 证书在节点执行时不在有效期内`);
        }
        await mkdir(dirname(certificatePath), { recursive: true, mode: 0o700 });
        const existingCertificate = await readFile(certificatePath).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        const existingPrivateKey = await readFile(keyPath).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (existingCertificate && !existingCertificate.equals(Buffer.from(certificatePem))) {
          throw new Error(`${name} 的不可变证书路径已存在不同内容`);
        }
        if (existingPrivateKey && !existingPrivateKey.equals(Buffer.from(privateKeyPemValue))) {
          throw new Error(`${name} 的不可变私钥路径已存在不同内容`);
        }
        const temporaryCertificate = `${certificatePath}.${process.pid}.tmp`;
        const temporaryKey = `${keyPath}.${process.pid}.tmp`;
        if (!existingCertificate) {
          await writeFile(temporaryCertificate, certificatePem, { mode: 0o644 });
          await rename(temporaryCertificate, certificatePath);
          createdPaths.push(certificatePath);
        }
        if (!existingPrivateKey) {
          await writeFile(temporaryKey, privateKeyPemValue, { mode: 0o600 });
          await rename(temporaryKey, keyPath);
          createdPaths.push(keyPath);
        }
        await chmod(certificatePath, 0o644);
        await chmod(keyPath, 0o600);
      }
    } catch (error) {
      await removeNewTlsAssets(createdPaths);
      throw error;
    }
    return {
      count: bundle.assets.length,
      rollback: () => removeNewTlsAssets(createdPaths)
    };
  }

  async publish(task, privateKeyPem = null) {
    if (!task?.configText) throw new Error("发布任务缺少 sing-box 配置");
    JSON.parse(task.configText);
    await mkdir(this.dataDir, { recursive: true, mode: 0o750 });
    const tlsInstallation = await this.installTlsBundle(task, privateKeyPem);
    const temporaryPath = join(this.dataDir, `.config-${process.pid}-${Date.now()}.json`);
    const backupPath = join(this.dataDir, "config.previous.json");
    let hadConfig = false;
    let published = false;
    let configActivated = false;
    const firewalls = [];

    try {
      hadConfig = await pathExists(this.configPath);
      if (task.activation && this.portVerifier.assertAvailable) {
        await this.portVerifier.assertAvailable(task.activation);
      }
      if (task.activation?.exposure === "public") {
        for (const rule of [
          task.activation,
          ...(task.activation.challengePorts || [])
        ]) {
          firewalls.push(await this.firewallManager.open(rule));
        }
      }
      await writeFile(temporaryPath, `${task.configText.trim()}\n`, { mode: 0o640 });
      await this.commandRunner(this.binaryPath, ["check", "-c", temporaryPath]);
      if (hadConfig) await copyFile(this.configPath, backupPath);
      await rename(temporaryPath, this.configPath);
      configActivated = true;
      if (this.runtimeMode === "systemd") {
        await this.commandRunner("systemctl", ["restart", this.systemdUnit]);
      }
      let activation = null;
      if (task.activation) {
        await this.portVerifier.waitForListening(task.activation);
        const useProtocolProbe = PROTOCOL_PROBE_TYPES.has(task.activation.type);
        const publicCheck = task.activation.exposure === "public"
          ? useProtocolProbe
            ? await this.protocolProbe.verify({
                ...task.activation,
                configText: task.configText
              })
            : await this.publicProbe.verify(task.activation)
          : { reachable: null, reason: "仅本机协议不执行公网探测" };
        activation = {
          firewallManaged: firewalls.some((item) => item.managed === true),
          publicCheck
        };
      }
      let runtimeVersion = "unknown";
      try {
        const version = await this.commandRunner(this.binaryPath, ["version"]);
        runtimeVersion = version.stdout.match(/sing-box version\s+([^\s]+)/i)?.[1] || "unknown";
      } catch {
        // Configuration and service activation already succeeded. A later heartbeat
        // will report the Runtime version without turning a valid publication into
        // a destructive rollback.
      }
      published = true;
      await pruneTlsReleases(this.dataDir, [this.configPath, backupPath]).catch((error) => {
        console.error(
          `[RayLink Node] ${new Date().toISOString()} 历史 TLS 资产清理失败：${error.message}`
        );
      });
      return {
        runtimeVersion,
        configPath: this.configPath,
        version: task.version,
        checksum: task.checksum,
        tlsAssetsInstalled: tlsInstallation.count,
        ...(activation ? { activation } : {})
      };
    } catch (error) {
      let rolledBack = true;
      if (configActivated) {
        try {
          if (hadConfig && await pathExists(backupPath)) {
            await copyFile(backupPath, temporaryPath);
            await rename(temporaryPath, this.configPath);
            if (this.runtimeMode === "systemd") {
              await this.commandRunner("systemctl", ["restart", this.systemdUnit]);
            }
          } else {
            await rm(this.configPath, { force: true });
            if (this.runtimeMode === "systemd") await this.stopSystemd();
          }
        } catch (rollbackError) {
          rolledBack = false;
          error.rollbackError = rollbackError.message;
        }
      }
      for (const firewall of firewalls.reverse()) {
        try {
          await firewall.rollback();
        } catch (rollbackError) {
          rolledBack = false;
          error.rollbackError = [
            error.rollbackError,
            `防火墙：${rollbackError.message}`
          ].filter(Boolean).join("；");
        }
      }
      error.rolledBack = rolledBack;
      throw error;
    } finally {
      await rm(temporaryPath, { force: true });
      if (!published) await tlsInstallation.rollback();
    }
  }

  async resolveBinaryPath() {
    if (isAbsolute(this.binaryPath)) return this.binaryPath;
    const { stdout } = await this.commandRunner("which", [this.binaryPath]);
    const resolvedPath = String(stdout || "").trim().split(/\s+/)[0];
    if (!resolvedPath || !isAbsolute(resolvedPath)) {
      throw new Error("无法定位 sing-box 可执行文件");
    }
    return resolvedPath;
  }

  async stopSystemd() {
    await this.commandRunner("systemctl", ["stop", this.systemdUnit], { timeout: 20_000 });
    let state;
    try {
      const { stdout } = await this.commandRunner("systemctl", ["is-active", this.systemdUnit], { timeout: 10_000 });
      state = String(stdout).trim();
    } catch (error) {
      if (error.code !== 3) throw error;
      state = String(error.stdout || error.cause?.stdout || "").trim();
    }
    if (!["inactive", "failed"].includes(state)) {
      throw new Error(`${this.systemdUnit} 停止后仍未确认退出（${state || "未知状态"}）`);
    }
  }

  async restartAndVerify(expectedVersion) {
    await this.commandRunner("systemctl", ["restart", this.systemdUnit]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { stdout } = await this.commandRunner("systemctl", ["is-active", this.systemdUnit]);
      if (String(stdout).trim() !== "active") {
        throw new Error(`${this.systemdUnit} 未恢复运行`);
      }
      if (attempt < 2 && this.healthCheckDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.healthCheckDelayMs));
      }
    }
    const version = await this.commandRunner(this.binaryPath, ["version"]);
    const runtimeVersion = version.stdout.match(/sing-box version\s+([^\s]+)/i)?.[1] || "unknown";
    if (expectedVersion && runtimeVersion !== expectedVersion) {
      throw new Error(
        `${this.systemdUnit} 运行版本不匹配：期望 ${expectedVersion}，实际 ${runtimeVersion}`
      );
    }
  }

  async installMeteredVersion(version, outputPath) {
    if (await this.installReleaseArtifact(version, outputPath)) return;
    if (!await pathExists(this.meteredRuntimeBuilder)) {
      throw new Error("控制台缺少预编译 Runtime，节点也缺少构建器，请先升级 RayLink 发布包");
    }
    await this.commandRunner("sh", [
      this.meteredRuntimeBuilder,
      version,
      outputPath
    ], {
      timeout: 20 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024
    });
  }

  async installReleaseArtifact(version, outputPath) {
    if (!this.runtimeArtifactBaseUrl) return false;
    const runtimeArch = this.runtimeArch === "x64"
      ? "amd64"
      : this.runtimeArch === "arm64"
        ? "arm64"
        : "";
    if (!runtimeArch) {
      throw new Error(`预编译 Runtime 不支持当前架构：${this.runtimeArch}`);
    }
    const artifactName = `raylink-sing-box-${version}-linux-${runtimeArch}`;
    const artifactUrl = `${this.runtimeArtifactBaseUrl}/${artifactName}`;
    const cronetName = `raylink-libcronet-${version}-linux-${runtimeArch}.so`;
    const cronetUrl = `${this.runtimeArtifactBaseUrl}/${cronetName}`;
    const artifactResponse = await this.fetchFn(artifactUrl);
    if (artifactResponse.status === 404) return false;
    if (!artifactResponse.ok) {
      throw new Error(`下载预编译 Runtime 失败：HTTP ${artifactResponse.status}`);
    }
    const checksumResponse = await this.fetchFn(`${artifactUrl}.sha256`);
    if (checksumResponse.status === 404) return false;
    if (!checksumResponse.ok) {
      throw new Error(`下载 Runtime 校验文件失败：HTTP ${checksumResponse.status}`);
    }
    const cronetResponse = await this.fetchFn(cronetUrl);
    if (!cronetResponse.ok) {
      throw new Error(`下载 Cronet 依赖失败：HTTP ${cronetResponse.status}`);
    }
    const cronetChecksumResponse = await this.fetchFn(`${cronetUrl}.sha256`);
    if (!cronetChecksumResponse.ok) {
      throw new Error(`下载 Cronet 校验文件失败：HTTP ${cronetChecksumResponse.status}`);
    }
    const expectedChecksum = String(await checksumResponse.text()).trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(expectedChecksum)) {
      throw new Error("预编译 Runtime 校验文件格式错误");
    }
    const expectedCronetChecksum = String(
      await cronetChecksumResponse.text()
    ).trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(expectedCronetChecksum)) {
      throw new Error("预编译 Cronet 校验文件格式错误");
    }
    const artifact = Buffer.from(await artifactResponse.arrayBuffer());
    const actualChecksum = createHash("sha256").update(artifact).digest("hex");
    if (actualChecksum !== expectedChecksum) {
      throw new Error("预编译 Runtime SHA-256 校验失败");
    }
    const cronetArtifact = Buffer.from(await cronetResponse.arrayBuffer());
    const actualCronetChecksum = createHash("sha256").update(cronetArtifact).digest("hex");
    if (actualCronetChecksum !== expectedCronetChecksum) {
      throw new Error("预编译 Cronet SHA-256 校验失败");
    }
    const candidatePath = `${outputPath}.release-${process.pid}-${Date.now()}`;
    const cronetOutputPath = join(dirname(outputPath), "libcronet.so");
    const cronetCandidatePath = `${cronetOutputPath}.release-${process.pid}-${Date.now()}`;
    try {
      await writeFile(candidatePath, artifact, { mode: 0o755 });
      await chmod(candidatePath, 0o755);
      await writeFile(cronetCandidatePath, cronetArtifact, { mode: 0o644 });
      await chmod(cronetCandidatePath, 0o644);
      await rename(cronetCandidatePath, cronetOutputPath);
      await rename(candidatePath, outputPath);
    } finally {
      await rm(candidatePath, { force: true });
      await rm(cronetCandidatePath, { force: true });
    }
    return true;
  }

  async commandState(action, unit) {
    try {
      const { stdout } = await this.commandRunner("systemctl", [action, unit]);
      return String(stdout || "").trim();
    } catch (error) {
      return String(error.stdout || error.message || "").trim();
    }
  }

  async inspectConflictingSystemdService() {
    if (this.runtimeMode !== "systemd" || this.systemdUnit === "sing-box.service") return null;
    const units = await this.commandRunner(
      "systemctl",
      ["list-unit-files", "sing-box.service", "--no-legend"]
    );
    if (!String(units.stdout || "").includes("sing-box.service")) {
      return { exists: false, enabled: false, active: false };
    }
    return {
      exists: true,
      enabled: await this.commandState("is-enabled", "sing-box.service") === "enabled",
      active: await this.commandState("is-active", "sing-box.service") === "active"
    };
  }

  async disableConflictingSystemdService() {
    if (this.runtimeMode !== "systemd" || this.systemdUnit === "sing-box.service") return;
    const units = await this.commandRunner(
      "systemctl",
      ["list-unit-files", "sing-box.service", "--no-legend"]
    );
    if (String(units.stdout || "").includes("sing-box.service")) {
      await this.commandRunner("systemctl", ["disable", "--now", "sing-box.service"]);
    }
  }

  async restoreConflictingSystemdService(previousState) {
    if (!previousState) return;
    const units = await this.commandRunner(
      "systemctl",
      ["list-unit-files", "sing-box.service", "--no-legend"]
    );
    if (!String(units.stdout || "").includes("sing-box.service")) return;
    await this.commandRunner(
      "systemctl",
      [previousState.enabled ? "enable" : "disable", "sing-box.service"]
    );
    await this.commandRunner(
      "systemctl",
      [previousState.active ? "start" : "stop", "sing-box.service"]
    );
  }

  async upgrade(task) {
    const targetVersion = String(task?.targetVersion || "");
    if (targetVersion !== "1.14.2") {
      throw new Error("RayLink 当前只批准升级到 sing-box 1.14.2 计量版");
    }
    await mkdir(this.dataDir, { recursive: true, mode: 0o750 });
    const resolvedBinaryPath = await this.resolveBinaryPath();
    const backupPath = join(this.dataDir, "sing-box.previous.binary");
    const cronetPath = join(dirname(resolvedBinaryPath), "libcronet.so");
    const backupCronetPath = join(this.dataDir, "libcronet.previous.so");
    const cronetHadPrevious = await pathExists(cronetPath);
    const previous = await this.commandRunner(this.binaryPath, ["version"]);
    const previousVersion = previous.stdout.match(/sing-box version\s+([^\s]+)/i)?.[1] || "unknown";
    const meteredRuntime = /(?:^|,)\s*with_v2ray_api(?:,|$)/m.test(
      previous.stdout.match(/Tags:\s*(.+)/i)?.[1] || ""
    );
    if (previousVersion === targetVersion && (!this.preferMeteredRuntime || meteredRuntime)) {
      return { runtimeVersion: targetVersion, previousVersion, alreadyCurrent: true, rolledBack: false };
    }
    if (!await pathExists(this.configPath)) {
      throw new Error("当前 Runtime 没有活动配置，请先完成配置发布");
    }
    const conflictingServiceState = await this.inspectConflictingSystemdService();
    if (conflictingServiceState?.active) {
      throw new Error(
        "检测到非 RayLink 管理的 sing-box.service 正在运行，请先确认并停止该服务"
      );
    }
    await copyFile(resolvedBinaryPath, backupPath);
    await chmod(backupPath, 0o700);
    if (cronetHadPrevious) {
      await copyFile(cronetPath, backupCronetPath);
      await chmod(backupCronetPath, 0o600);
    }

    try {
      const requireMeteredRuntime = true;
      await this.installMeteredVersion(targetVersion, resolvedBinaryPath);
      const installed = await this.commandRunner(this.binaryPath, ["version"]);
      const runtimeVersion = installed.stdout.match(/sing-box version\s+([^\s]+)/i)?.[1] || "unknown";
      if (runtimeVersion !== targetVersion) {
        throw new Error(`升级后版本不匹配：期望 ${targetVersion}，实际 ${runtimeVersion}`);
      }
      if (requireMeteredRuntime && !String(installed.stdout).includes("with_v2ray_api")) {
        throw new Error("升级后的 Runtime 丢失 with_v2ray_api，拒绝切换");
      }
      const hasConfig = await pathExists(this.configPath);
      if (hasConfig) {
        await this.commandRunner(this.binaryPath, ["check", "-c", this.configPath]);
        await this.disableConflictingSystemdService();
        if (this.runtimeMode === "systemd") await this.restartAndVerify(targetVersion);
      }
      return { runtimeVersion, previousVersion, rolledBack: false };
    } catch (error) {
      try {
        await copyFile(backupPath, resolvedBinaryPath);
        await chmod(resolvedBinaryPath, 0o755);
        if (cronetHadPrevious) {
          await copyFile(backupCronetPath, cronetPath);
          await chmod(cronetPath, 0o644);
        } else {
          await rm(cronetPath, { force: true });
        }
        await this.restoreConflictingSystemdService(conflictingServiceState);
        if (this.runtimeMode === "systemd" && await pathExists(this.configPath)) {
          await this.restartAndVerify(previousVersion);
        }
      } catch (rollbackError) {
        const failure = new Error(`sing-box 升级失败且回滚失败：${rollbackError.message}`);
        failure.rolledBack = false;
        failure.previousVersion = previousVersion;
        throw failure;
      }
      const failure = new Error(`sing-box 升级失败，已回滚到 ${previousVersion}：${error.message}`);
      failure.rolledBack = true;
      failure.packageMetadataRestored = true;
      failure.previousVersion = previousVersion;
      throw failure;
    }
  }
}

export async function collectNodeMetadata(binaryPath = "sing-box", telemetryCollector = null) {
  let runtimeVersion = null;
  let buildTags = [];
  try {
    const result = await runCommand(binaryPath, ["version"]);
    runtimeVersion = result.stdout.match(/sing-box version\s+([^\s]+)/i)?.[1] || null;
    const tags = result.stdout.match(/Tags:\s*(.+)/i)?.[1];
    buildTags = tags ? tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
  } catch {
    // The installer may enroll before the runtime is available.
  }
  return {
    hostname: hostname(),
    platform: platform(),
    architecture: arch(),
    agentVersion: AGENT_VERSION,
    runtimeVersion,
    buildTags,
    telemetry: telemetryCollector ? await telemetryCollector.collect() : undefined
  };
}

export class RayLinkNode {
  constructor(options = {}) {
    this.serverUrl = String(options.serverUrl || "").replace(/\/+$/, "");
    if (this.serverUrl) {
      const server = new URL(this.serverUrl);
      const loopback = ["127.0.0.1", "::1", "localhost"].includes(server.hostname);
      if (server.protocol !== "https:" && !loopback) {
        throw new Error("RayLink Node 生产连接必须使用 HTTPS");
      }
    }
    this.enrollmentToken = options.enrollmentToken || "";
    this.statePath = options.statePath || "/etc/raylink-node/node.json";
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.runtimeAdapter = options.runtimeAdapter || new NodeRuntimeAdapter({
      ...options,
      fetchFn: this.fetchFn,
      runtimeArtifactBaseUrl: options.runtimeArtifactBaseUrl
        || `${this.serverUrl}/node/runtime`,
      preferMeteredRuntime: options.preferMeteredRuntime !== false
    });
    this.telemetryCollector = options.telemetryCollector || new NodeTelemetryCollector({
      systemdUnit: this.runtimeAdapter.systemdUnit
    });
    this.usageCollector = options.usageCollector || new NodeUsageCollector({
      systemdUnit: this.runtimeAdapter.systemdUnit,
      endpoint: options.v2rayStatsEndpoint || "http://127.0.0.1:10085"
    });
    this.metadataProvider = options.metadataProvider
      || (() => collectNodeMetadata(this.runtimeAdapter.binaryPath, this.telemetryCollector));
    this.pollIntervalMs = Number(options.pollIntervalMs || 10_000);
    this.requestTimeoutMs = Math.max(10, Number(options.requestTimeoutMs || 30_000));
    this.state = null;
  }

  async request(path, init = {}) {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    let response;
    try {
      response = await this.fetchFn(`${this.serverUrl}${path}`, {
        ...init,
        signal,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers || {})
        }
      });
    } catch (error) {
      if (timeoutSignal.aborted && !init.signal?.aborted) {
        throw new Error(`控制面请求超时（${this.requestTimeoutMs}ms）`);
      }
      throw error;
    }
    if (!response.ok) {
      let message = `控制面请求失败（HTTP ${response.status}）`;
      try {
        const body = await response.json();
        message = body.error?.message || body.message || message;
      } catch {
        // Keep the status-based message when the response is not JSON.
      }
      throw new Error(message);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async loadState() {
    if (this.state) return this.state;
    try {
      this.state = JSON.parse(await readFile(this.statePath, "utf8"));
      if (!this.state.hostId || !this.state.nodeSecret) throw new Error("节点凭据不完整");
      return this.state;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async persistState(state) {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.statePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.statePath);
    await chmod(this.statePath, 0o600);
    this.state = state;
  }

  async ensureEncryptionState(state) {
    if (state.encryptionPublicKey && state.encryptionPrivateKey) return state;
    const next = { ...state, ...generateEncryptionKeypair() };
    await this.persistState(next);
    return next;
  }

  async ensureEnrolled() {
    const existing = await this.loadState();
    if (existing) return this.ensureEncryptionState(existing);
    if (!this.serverUrl) throw new Error("缺少 RAYLINK_SERVER");
    if (!this.enrollmentToken) throw new Error("缺少 RAYLINK_ENROLL_TOKEN");
    const keypair = generateEncryptionKeypair();
    const metadata = await this.metadataProvider();
    const credential = await this.request("/api/node/enroll", {
      method: "POST",
      body: JSON.stringify({
        token: this.enrollmentToken,
        ...metadata,
        encryptionPublicKey: keypair.encryptionPublicKey
      })
    });
    const state = {
      hostId: credential.hostId,
      nodeSecret: credential.nodeSecret,
      ...keypair
    };
    await this.persistState(state);
    return state;
  }

  async authenticatedRequest(path, init = {}) {
    const state = await this.ensureEnrolled();
    return this.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${state.nodeSecret}`,
        "x-raylink-host-id": state.hostId,
        ...(init.headers || {})
      }
    });
  }

  async completeTask(taskId, attempt, status, result) {
    return this.authenticatedRequest(`/api/node/tasks/${encodeURIComponent(taskId)}/complete`, {
      method: "POST",
      body: JSON.stringify({ attempt, status, result })
    });
  }

  async flushTaskReceipt() {
    const state = await this.ensureEnrolled();
    const receipt = state.pendingTaskReceipt;
    if (!receipt) return false;
    await this.completeTask(receipt.taskId, receipt.attempt, receipt.status, receipt.result);
    const next = { ...state };
    delete next.pendingTaskReceipt;
    await this.persistState(next);
    return true;
  }

  async pollOnce() {
    const state = await this.ensureEnrolled();
    // Report the previous execution before claiming work, including after a Node restart.
    if (await this.flushTaskReceipt()) return true;
    const metadata = await this.metadataProvider();
    await this.authenticatedRequest("/api/node/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        ...metadata,
        encryptionPublicKey: state.encryptionPublicKey
      })
    });
    if (metadata.buildTags?.includes("with_v2ray_api")) {
      try {
        await this.authenticatedRequest("/api/node/usage", {
          method: "POST",
          body: JSON.stringify(await this.usageCollector.collect())
        });
      } catch (error) {
        console.error(`[RayLink Node] ${new Date().toISOString()} 用户流量上报失败：${error.message}`);
        await this.authenticatedRequest("/api/node/usage/status", {
          method: "POST",
          body: JSON.stringify({ status: "error", error: error.message })
        }).catch((statusError) => {
          console.error(
            `[RayLink Node] ${new Date().toISOString()} 计量故障状态上报失败：${statusError.message}`
          );
        });
      }
    }
    const task = await this.authenticatedRequest("/api/node/tasks/next");
    if (!task) return false;
    let receipt;
    try {
      const result = task.kind === "publish-config"
        ? await this.runtimeAdapter.publish(task.payload, state.encryptionPrivateKey)
        : task.kind === "upgrade-runtime"
          ? await this.runtimeAdapter.upgrade(task.payload)
          : (() => { throw new Error(`不支持的节点任务：${task.kind}`); })();
      receipt = { taskId: task.id, attempt: task.attempt, status: "succeeded", result };
    } catch (error) {
      receipt = { taskId: task.id, attempt: task.attempt, status: "failed", result: {
        error: error.message,
        ...(error.previousVersion ? { previousVersion: error.previousVersion } : {}),
        ...(error.code ? { code: error.code } : {}),
        ...(Number.isInteger(error.suggestedPort)
          ? { suggestedPort: error.suggestedPort }
          : {}),
        ...(error.rollbackError ? { rollbackError: error.rollbackError } : {}),
        ...(typeof error.rolledBack === "boolean" ? { rolledBack: error.rolledBack } : {}),
        ...(typeof error.packageMetadataRestored === "boolean"
          ? { packageMetadataRestored: error.packageMetadataRestored }
          : {})
      } };
    }
    await this.persistState({ ...state, pendingTaskReceipt: receipt });
    await this.flushTaskReceipt();
    return true;
  }

  async run() {
    let delayMs = this.pollIntervalMs;
    for (;;) {
      try {
        const handledTask = await this.pollOnce();
        delayMs = handledTask ? 500 : this.pollIntervalMs;
      } catch (error) {
        console.error(`[RayLink Node] ${new Date().toISOString()} ${error.message}`);
        delayMs = Math.min(Math.max(delayMs * 2, 5_000), 60_000);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main() {
  const node = new RayLinkNode({
    serverUrl: process.env.RAYLINK_SERVER,
    enrollmentToken: process.env.RAYLINK_ENROLL_TOKEN,
    statePath: process.env.RAYLINK_NODE_STATE,
    dataDir: process.env.RAYLINK_NODE_DATA,
    binaryPath: process.env.SING_BOX_BIN,
    systemdUnit: process.env.SING_BOX_SYSTEMD_UNIT,
    runtimeMode: process.env.RAYLINK_RUNTIME_MODE,
    protocolProbeUrl: process.env.RAYLINK_PROTOCOL_PROBE_URL,
    preferMeteredRuntime: process.env.RAYLINK_ENABLE_USER_METERING !== "false"
  });
  await node.run();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[RayLink Node] 启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
