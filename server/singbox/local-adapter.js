import { execFile as execFileCallback } from "node:child_process";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

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

  async publish({ version, checksum, configText }) {
    JSON.parse(configText);
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const safeVersion = version.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const candidatePath = join(this.runtimeDir, `config.${safeVersion}.tmp`);
    await writeFile(candidatePath, configText, { mode: 0o600 });

    try {
      const validation = await this.validate(candidatePath);
      let hadActiveConfig = false;
      try {
        await access(this.activePath);
        hadActiveConfig = true;
        await copyFile(this.activePath, this.backupPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      await rename(candidatePath, this.activePath);
      if (this.mode === "systemd") {
        try {
          await this.restartSystemd();
        } catch (error) {
          try {
            if (hadActiveConfig) {
              await copyFile(this.backupPath, candidatePath);
              await rename(candidatePath, this.activePath);
              await this.restartSystemd();
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

      let runtimeVersion = null;
      try {
        runtimeVersion = await this.binaryVersion();
      } catch {}
      return {
        mode: this.mode,
        configPath: this.activePath,
        checksum,
        validation,
        runtimeVersion
      };
    } finally {
      await rm(candidatePath, { force: true });
    }
  }

  async status() {
    let configPresent = false;
    try {
      await access(this.activePath);
      configPresent = true;
    } catch {}

    if (this.mode === "dry-run") {
      return {
        state: configPresent ? "staged" : "not-configured",
        mode: this.mode,
        configPath: this.activePath,
        runtimeVersion: await this.binaryVersion()
      };
    }

    try {
      const { stdout } = await this.runner("systemctl", ["is-active", this.systemdUnit], { timeout: 10_000 });
      return {
        state: String(stdout).trim() === "active" ? "running" : "stopped",
        mode: this.mode,
        configPath: this.activePath,
        runtimeVersion: await this.binaryVersion()
      };
    } catch {
      return {
        state: "stopped",
        mode: this.mode,
        configPath: this.activePath,
        runtimeVersion: null
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
