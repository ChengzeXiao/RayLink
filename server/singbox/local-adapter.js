import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { connect as tlsConnect } from "node:tls";

import {
  buildProtocolProbeConfig,
  DEFAULT_PROTOCOL_PROBE_URL
} from "./protocol-probe.js";

const execFile = promisify(execFileCallback);

function commandFailure(error, fallback) {
  const detail = String(error.stderr || error.stdout || error.message || fallback).trim();
  const wrapped = new Error(detail || fallback);
  wrapped.cause = error;
  return wrapped;
}

export class LocalSingBoxAdapter {
  constructor({
    dataDir,
    binaryPath = "sing-box",
    mode = "dry-run",
    systemdUnit = "sing-box.service",
    protocolProbeUrl = DEFAULT_PROTOCOL_PROBE_URL,
    protocolProbeAttempts = 3,
    protocolProbeDelayMs = 1_000,
    runner = execFile
  }) {
    if (!["dry-run", "systemd"].includes(mode)) throw new Error(`Unsupported runtime mode: ${mode}`);
    if (!/^[a-zA-Z0-9@_.-]+$/.test(systemdUnit)) throw new Error("Invalid systemd unit");
    this.runtimeDir = join(dataDir, "sing-box");
    this.activePath = join(this.runtimeDir, "config.json");
    this.backupPath = join(this.runtimeDir, "config.json.bak");
    this.activationPath = join(this.runtimeDir, "activation.json");
    this.binaryPath = binaryPath;
    this.mode = mode;
    this.systemdUnit = systemdUnit;
    this.protocolProbeUrl = protocolProbeUrl;
    this.protocolProbeAttempts = Math.max(1, Number(protocolProbeAttempts || 3));
    this.protocolProbeDelayMs = Math.max(0, Number(protocolProbeDelayMs || 0));
    this.runner = runner;
  }

  async binaryVersion() {
    try {
      const { stdout } = await this.runner(this.binaryPath, ["version"], { timeout: 5_000 });
      return String(stdout).match(/sing-box version\s+([^\s]+)/i)?.[1] || String(stdout).trim() || null;
    } catch (error) {
      if (error.code === "ENOENT" && this.mode === "dry-run") return null;
      throw commandFailure(error, "无法读取 sing-box 版本");
    }
  }

  async validate(candidatePath) {
    try {
      await this.runner(this.binaryPath, ["check", "-c", candidatePath], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024
      });
      return "sing-box";
    } catch (error) {
      if (error.code === "ENOENT" && this.mode === "dry-run") {
        JSON.parse(await readFile(candidatePath, "utf8"));
        return "json-only";
      }
      throw commandFailure(error, "sing-box 配置校验失败");
    }
  }

  async restartSystemd() {
    try {
      await this.runner("systemctl", ["restart", this.systemdUnit], { timeout: 20_000 });
      const { stdout } = await this.runner("systemctl", ["is-active", this.systemdUnit], { timeout: 10_000 });
      if (String(stdout).trim() !== "active") throw new Error(`${this.systemdUnit} is not active`);
    } catch (error) {
      throw commandFailure(error, "sing-box 服务重启失败");
    }
  }

  async stopSystemd() {
    await this.runner("systemctl", ["stop", this.systemdUnit], { timeout: 20_000 });
    let state;
    try {
      const { stdout } = await this.runner("systemctl", ["is-active", this.systemdUnit], { timeout: 10_000 });
      state = String(stdout).trim();
    } catch (error) {
      if (error.code !== 3) throw error;
      state = String(error.stdout || "").trim();
    }
    if (!["inactive", "failed"].includes(state)) {
      throw new Error(`${this.systemdUnit} 停止后仍未确认退出（${state || "未知状态"}）`);
    }
  }

  async runtimeInstanceId() {
    try {
      const { stdout } = await this.runner("systemctl", ["show", this.systemdUnit, "--property=InvocationID", "--value"], { timeout: 5_000 });
      const value = String(stdout).trim().toLowerCase();
      return /^[a-f0-9]{32}$/.test(value) && !/^0+$/.test(value) ? value : null;
    } catch { return null; }
  }

  async activationInputs(configText) {
    const config = JSON.parse(configText);
    const paths = new Set();
    let complete = true;
    const collect = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        // Providers and ACME can rotate material outside explicit paths. Their
        // storage cannot be completely fingerprinted here, so never infer no-op.
        if ((key === "certificate_providers" && child && (!Array.isArray(child) || child.length))
          || (["acme", "certificate_provider"].includes(key) && child)) complete = false;
        if (/(?:certificate|key)_path$/.test(key)) {
          if (typeof child !== "string" || !isAbsolute(child)) complete = false;
          else paths.add(child);
        } else if (child && typeof child === "object") collect(child);
      }
    };
    collect(config);
    const checksum = createHash("sha256").update(configText).digest("hex");
    // Always bind known files, including when a different listener uses a
    // provider. Completeness only controls no-op eligibility; configuration and
    // known-asset proof still prevent provider reconciliation restart loops.
    const assets = [];
    for (const path of [...paths].sort()) {
      assets.push([path, createHash("sha256").update(await readFile(path)).digest("hex")]);
    }
    return {
      checksum,
      tlsChecksum: createHash("sha256").update(JSON.stringify(assets)).digest("hex"),
      tlsInputsComplete: complete
    };
  }

  async activationMatches(configText, evidence, expectedInstanceId = null) {
    const runtimeInstanceId = await this.runtimeInstanceId();
    const inputs = await this.activationInputs(configText);
    if (!runtimeInstanceId || (expectedInstanceId && runtimeInstanceId !== expectedInstanceId)
      || !inputs || evidence?.runtimeInstanceId !== runtimeInstanceId
      || evidence.checksum !== inputs.checksum || evidence.tlsChecksum !== inputs.tlsChecksum
      || evidence.tlsInputsComplete !== inputs.tlsInputsComplete) return false;
    if (await readFile(this.activePath, "utf8") !== configText
      || await this.runtimeInstanceId() !== runtimeInstanceId) return false;
    const confirmedInputs = await this.activationInputs(configText);
    return Boolean(confirmedInputs && confirmedInputs.checksum === inputs.checksum
      && confirmedInputs.tlsChecksum === inputs.tlsChecksum
      && confirmedInputs.tlsInputsComplete === inputs.tlsInputsComplete);
  }

  async recordActivation(configText, version = null, expectedInputs = null) {
    if (!expectedInputs) return false;
    const runtimeInstanceId = await this.runtimeInstanceId();
    const evidence = { ...expectedInputs, runtimeInstanceId, version };
    if (!await this.activationMatches(configText, evidence)) return false;
    const path = `${this.activationPath}.tmp`;
    try {
      await writeFile(path, JSON.stringify(evidence), { mode: 0o600 });
      await rename(path, this.activationPath);
      return await this.activationMatches(configText, evidence);
    } finally { await rm(path, { force: true }); }
  }

  async activateCertificates({ config, certificates }) {
    if (this.mode !== "systemd") throw new Error("TLS activation requires a live systemd Runtime");
    const expectedConfigText = await readFile(this.activePath, "utf8");
    await this.validate(this.activePath);
    const expectedInputs = await this.activationInputs(expectedConfigText).catch(() => null);
    await this.restartSystemd();
    const expected = new Map(certificates.map((certificate) => [certificate.domain, certificate]));
    const inbounds = (config.inbounds || []).filter((inbound) => (
      expected.get(inbound.tls?.server_name?.toLowerCase())?.inboundTags?.includes(inbound.tag)
    ));
    if (!inbounds.length) throw new Error("No managed TLS listeners to verify");
    for (const inbound of inbounds) {
      const address = inbound.listen === "::" ? "::1"
        : !inbound.listen || inbound.listen === "0.0.0.0" ? "127.0.0.1" : inbound.listen;
      if (["tuic", "hysteria", "hysteria2"].includes(inbound.type) || inbound.transport?.type === "quic") {
        await this.probeProtocol({ type: inbound.type, address, port: inbound.listen_port,
          serverConfig: config, attempts: 2, timeoutMs: 12_000 });
        continue;
      }
      const verify = () => new Promise((resolve, reject) => {
        const socket = tlsConnect({ host: address, port: inbound.listen_port,
          servername: inbound.tls.server_name, rejectUnauthorized: true });
        socket.setTimeout(5_000);
        socket.once("secureConnect", () => {
          const matches = socket.getPeerCertificate().fingerprint256 === expected.get(inbound.tls.server_name.toLowerCase()).fingerprint256;
          socket.destroy();
          if (matches) resolve();
          else reject(new Error("Runtime TLS certificate fingerprint does not match the renewed certificate"));
        });
        socket.once("timeout", () => socket.destroy(new Error("Runtime TLS verification timed out")));
        socket.once("error", reject);
      });
      const deadline = Date.now() + 10_000;
      for (;;) {
        try { await verify(); break; }
        catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }
    try { await this.recordActivation(expectedConfigText, null, expectedInputs); } catch {}
  }

  async publish({ version, checksum, configText }) {
    JSON.parse(configText);
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const safeVersion = version.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const candidatePath = join(this.runtimeDir, `config.${safeVersion}.tmp`);
    await writeFile(candidatePath, configText, { mode: 0o600 });

    try {
      const validation = await this.validate(candidatePath);
      const actualChecksum = createHash("sha256").update(configText).digest("hex");
      let sameFile = false;
      try { sameFile = await readFile(this.activePath, "utf8") === configText; } catch {}
      const before = sameFile ? await this.status() : null;
      if (before?.configChecksum === actualChecksum && (this.mode === "dry-run"
        || before.state === "running" && before.appliedChecksum === actualChecksum && before.noOpEligible)) {
        return { mode: this.mode, configPath: this.activePath, checksum, validation,
          runtimeVersion: before.runtimeVersion, activationConfirmed: true,
          tlsActivationConfirmed: this.mode === "systemd" && before.tlsConfigurationIntegrity === "verified",
          unchanged: true };
      }
      let hadActiveConfig = false;
      try {
        await access(this.activePath);
        hadActiveConfig = true;
        await copyFile(this.activePath, this.backupPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      await rename(candidatePath, this.activePath);
      const expectedInputs = this.mode === "systemd"
        ? await this.activationInputs(configText).catch(() => null) : null;
      if (this.mode === "systemd") {
        try {
          await this.restartSystemd();
        } catch (error) {
          try {
            if (hadActiveConfig) {
              const previousConfigText = await readFile(this.backupPath, "utf8");
              await writeFile(candidatePath, previousConfigText, { mode: 0o600 });
              await rename(candidatePath, this.activePath);
              const rollbackInputs = await this.activationInputs(previousConfigText).catch(() => null);
              await this.restartSystemd();
              try { await this.recordActivation(previousConfigText, null, rollbackInputs); } catch {}
            } else {
              await rm(this.activePath, { force: true });
              await this.stopSystemd();
            }
            error.rolledBack = true;
          } catch (rollbackError) {
            error.rolledBack = false;
            error.rollbackError = rollbackError.message;
          }
          throw error;
        }
      }

      let activationConfirmed = this.mode === "dry-run";
      if (this.mode === "systemd") {
        // Failure to persist evidence must not turn a completed activation into
        // a retryable mutation failure. Status stays unverified until repaired.
        try { activationConfirmed = await this.recordActivation(configText, version, expectedInputs); } catch {}
      }

      let runtimeVersion = null;
      try {
        runtimeVersion = await this.binaryVersion();
      } catch {}
      return {
        mode: this.mode,
        configPath: this.activePath,
        checksum,
        validation,
        runtimeVersion,
        activationConfirmed,
        tlsActivationConfirmed: activationConfirmed && this.mode === "systemd" && expectedInputs?.tlsInputsComplete === true,
        unchanged: false
      };
    } finally {
      await rm(candidatePath, { force: true });
    }
  }

  async status() {
    let configChecksum = null, configText = null, evidence = null;
    try {
      configText = await readFile(this.activePath, "utf8");
      configChecksum = createHash("sha256").update(configText).digest("hex");
    } catch {}
    try { evidence = JSON.parse(await readFile(this.activationPath, "utf8")); } catch {}
    let runtimeVersion = null;
    try { runtimeVersion = await this.binaryVersion(); } catch {}

    if (this.mode === "dry-run") {
      return {
        state: configChecksum ? "staged" : "not-configured",
        mode: this.mode,
        configPath: this.activePath,
        runtimeVersion, configChecksum, appliedChecksum: null,
        configurationIntegrity: configChecksum ? "staged" : "not-configured"
      };
    }

    try {
      const { stdout } = await this.runner("systemctl", ["is-active", this.systemdUnit], { timeout: 10_000 });
      const running = String(stdout).trim() === "active";
      const runtimeInstanceId = running ? await this.runtimeInstanceId() : null;
      const verified = running && runtimeInstanceId && configText
        && await this.activationMatches(configText, evidence, runtimeInstanceId).catch(() => false);
      const tlsInputsAvailable = verified && evidence?.tlsInputsComplete === true;
      return {
        state: running ? "running" : "stopped",
        mode: this.mode,
        configPath: this.activePath,
        runtimeVersion, configChecksum, runtimeInstanceId,
        appliedChecksum: verified ? configChecksum : null,
        noOpEligible: Boolean(tlsInputsAvailable),
        tlsConfigurationIntegrity: !verified ? "unverified" : tlsInputsAvailable ? "verified" : "unavailable",
        configurationIntegrity: verified ? "verified" : !configChecksum ? "not-configured"
          : evidence?.checksum && evidence.checksum !== configChecksum ? "drifted" : "unverified"
      };
    } catch {
      return {
        state: "stopped",
        mode: this.mode,
        configPath: this.activePath,
        runtimeVersion, configChecksum, appliedChecksum: null, configurationIntegrity: "unverified"
      };
    }
  }

  async probeProtocol({
    type,
    address,
    port,
    serverConfig = null,
    attempts = this.protocolProbeAttempts,
    timeoutMs = 30_000
  }) {
    const sourceConfig = serverConfig
      || JSON.parse(await readFile(this.activePath, "utf8"));
    const probeConfig = buildProtocolProbeConfig({
      type,
      address,
      port,
      serverConfig: sourceConfig
    });
    const probePath = join(
      this.runtimeDir,
      `.protocol-probe-${type}-${process.pid}-${Date.now()}.json`
    );
    await writeFile(probePath, `${JSON.stringify(probeConfig, null, 2)}\n`, { mode: 0o600 });
    try {
      await this.runner(this.binaryPath, ["check", "-c", probePath], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024
      });
      let lastError = null;
      let latencyMs = null;
      const attemptCount = Math.max(1, Number(attempts || 1));
      for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
        try {
          const startedAt = performance.now();
          await this.runner(this.binaryPath, [
            "tools",
            "fetch",
            "-c",
            probePath,
            "-o",
            "raylink-probe",
            this.protocolProbeUrl
          ], {
            timeout: Math.max(1_000, Number(timeoutMs || 30_000)),
            maxBuffer: 1024 * 1024
          });
          latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < attemptCount && this.protocolProbeDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.protocolProbeDelayMs));
          }
        }
      }
      if (lastError) throw lastError;
      return {
        reachable: true,
        probe: "sing-box-tools-fetch",
        protocol: type,
        target: this.protocolProbeUrl,
        latencyMs
      };
    } catch (error) {
      const wrapped = commandFailure(error, `${type} 协议握手或外部访问失败`);
      wrapped.code = "PROTOCOL_HANDSHAKE_FAILED";
      throw wrapped;
    } finally {
      await rm(probePath, { force: true });
    }
  }
}
