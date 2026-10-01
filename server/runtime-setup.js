import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { platform as currentPlatform } from "node:os";
import { dirname } from "node:path";

import { LocalPortManager, UfwFirewallManager } from "./protocol-activation.js";
import { APPROVED_METERED_RUNTIME_VERSION, compareVersions } from "./singbox/installer.js";

const stepLabels = [
  ["install", "安装计量版 sing-box"],
  ["bbr", "配置 BBR 与 fq 队列"],
  ["protocol", "配置 Shadowsocks 与防火墙"],
  ["publish", "校验并发布 Runtime 配置"],
  ["health", "验证服务与协议监听"]
];

function setupError(code, message, statusCode = 500) {
  return Object.assign(new Error(message), { code, statusCode });
}

export class RuntimeSetupManager {
  constructor({
    store,
    installer,
    runtimeManager,
    runtimeAdapter,
    bbrManager,
    firewallManager = new UfwFirewallManager(),
    portManager = new LocalPortManager(),
    runtimeMode = "dry-run",
    platform = currentPlatform(),
    statePath = null,
    clock = () => new Date()
  }) {
    Object.assign(this, {
      store, installer, runtimeManager, runtimeAdapter, bbrManager,
      firewallManager, portManager, runtimeMode, platform, statePath, clock
    });
    this.state = this.initialState();
    if (statePath && this.state.status !== "development") {
      try {
        const saved = JSON.parse(readFileSync(statePath, "utf8"));
        if (!["idle", "running", "succeeded", "failed"].includes(saved.status)
          || !Array.isArray(saved.steps) || !Array.isArray(saved.warnings)) {
          throw new Error("安装进度格式无效");
        }
        this.state = saved;
        if (saved.status === "running") {
          Object.assign(this.state, {
            status: "failed", ready: false, message: "上次自动安装因服务重启中断，可以重试",
            error: { code: "RUNTIME_SETUP_INTERRUPTED", message: "上次自动安装因服务重启中断，可以重试" },
            finishedAt: this.clock().toISOString()
          });
          this.state.steps = saved.steps.map((step) => step.status === "running" ? { ...step, status: "failed", message: this.state.message } : step);
          this.persist();
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          Object.assign(this.state, { status: "failed", ready: false, message: "无法读取上次安装进度，可以重新执行安装", error: { code: "RUNTIME_SETUP_STATE_INVALID", message: error.message } });
        }
      }
    }
  }

  initialState() {
    const supported = this.runtimeMode === "systemd" && this.platform === "linux";
    return {
      status: supported ? "idle" : "development",
      stage: null,
      ready: false,
      message: supported ? "等待自动安装与配置" : "本机演示模式不运行 Linux Runtime；请在 Linux 主控服务器执行自动安装",
      steps: stepLabels.map(([id, label]) => ({ id, label, status: "pending", message: "" })),
      warnings: []
    };
  }

  status() {
    return structuredClone(this.state);
  }

  persist() {
    if (!this.statePath) return;
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      renameSync(temporary, this.statePath);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch {}
      const warning = "无法持久化安装进度，服务重启后请重新检查 Runtime 状态";
      if (!this.state.warnings.includes(warning)) this.state.warnings.push(warning);
    }
  }

  step(id, status, message = "") {
    this.state.stage = id;
    const step = this.state.steps.find((candidate) => candidate.id === id);
    Object.assign(step, { status, message: message || step.label });
    this.state.message = step.message;
    this.persist();
  }

  async configure({ publisherAdminId = null } = {}) {
    if (this.runtimeMode !== "systemd" || this.platform !== "linux") {
      throw setupError("RUNTIME_AUTOMATION_UNSUPPORTED", this.state.message, 422);
    }
    if (this.state.status === "running") {
      throw setupError("RUNTIME_OPERATION_IN_PROGRESS", "Runtime 自动安装与配置正在执行", 409);
    }
    this.state = { ...this.initialState(), status: "running", startedAt: this.clock().toISOString() };
    const firewalls = [];
    let originalProfile;
    let changedProfile = false;
    let published = false;
    try {
      this.step("install", "running");
      const previousInstallation = await this.installer.status();
      const previousRuntime = previousInstallation.installed
        ? await this.runtimeManager.status() : null;
      const requiresReplacement = previousInstallation.installed && (
        compareVersions(previousInstallation.version, APPROVED_METERED_RUNTIME_VERSION) < 0
        || (previousInstallation.version === APPROVED_METERED_RUNTIME_VERSION
          && !previousInstallation.tags?.includes("with_v2ray_api"))
      );
      // Replacing a live binary must keep the installer's checked rollback path.
      const installation = requiresReplacement && previousRuntime?.state === "running"
        ? await this.installer.upgrade(APPROVED_METERED_RUNTIME_VERSION)
        : await this.installer.install();
      if (!installation.installed || !installation.tags?.includes("with_v2ray_api")) {
        throw setupError("METERING_BUILD_MISSING", "自动安装未得到支持用户计量的 sing-box Runtime");
      }
      if (this.runtimeAdapter && installation.binaryPath) {
        this.runtimeAdapter.binaryPath = installation.binaryPath;
      }
      this.store.updateLocalRuntimeCapabilities(installation);
      this.step("install", "succeeded");

      this.step("bbr", "running");
      let bbr;
      try {
        bbr = await this.bbrManager.configure();
      } catch (error) {
        bbr = { ...await this.bbrManager.inspect().catch(() => ({ status: "unavailable" })), error: error.message };
      }
      if (bbr.status !== "enabled") {
        const warning = bbr.error || "当前内核无法启用 BBR，协议安装继续；请查看网络加速状态";
        this.state.warnings.push(warning);
        this.step("bbr", "warning", warning);
      } else this.step("bbr", "succeeded");

      this.step("protocol", "running");
      originalProfile = this.store.listHostProtocolConfigs("local")
        .find((profile) => profile.type === "shadowsocks");
      if (!originalProfile) {
        throw setupError("PROTOCOL_NOT_FOUND", "缺少默认 Shadowsocks 配置");
      }
      // Preserve existing keys, ports and advanced options across retries.
      const profile = originalProfile.enabled ? originalProfile
        : this.store.updateHostProtocolConfig("local", "shadowsocks", { ...originalProfile, enabled: true });
      changedProfile = !originalProfile.enabled;
      const inbound = this.runtimeManager.compileHostRuntimeConfig("local")
        .inbounds.find((entry) => entry.type === "shadowsocks");
      if (!inbound) throw setupError("PROTOCOL_NOT_CONFIGURED", "生成的配置中没有 Shadowsocks 入站");
      const networks = ["tcp", "udp"].includes(inbound.network) ? [inbound.network] : ["tcp", "udp"];
      for (const network of networks) {
        firewalls.push(await this.firewallManager.open({ port: profile.port, network }));
      }
      this.step("protocol", "succeeded");

      this.step("publish", "running");
      const deployment = await this.runtimeManager.publish(publisherAdminId, { reason: "automatic-runtime-setup" });
      published = true;
      this.step("publish", "succeeded");

      this.step("health", "running");
      for (const network of networks) {
        await this.portManager.waitForListening({ listen: profile.listen, port: profile.port, network });
      }
      const runtime = await this.runtimeManager.status();
      if (runtime.mode !== "systemd" || runtime.state !== "running") {
        throw setupError("RUNTIME_NOT_RUNNING", "配置已发布，但 sing-box 服务未确认运行");
      }
      const checkedAt = this.clock().toISOString();
      this.store.setProtocolActivation("local", "shadowsocks", {
        state: "port-listening", progress: 100, port: profile.port,
        network: networks.join(","), firewallManaged: firewalls.some((item) => item.managed),
        publicCheck: { reachable: null, checkedAt, reason: "本机服务与端口已验证，等待公网协议探测" },
        updatedAt: checkedAt
      });
      this.step("health", "succeeded");
      Object.assign(this.state, {
        status: "succeeded", ready: true,
        message: this.state.warnings.length ? "Runtime 已运行，网络加速存在待处理项" : "Runtime、Shadowsocks 与 BBR 已配置并运行",
        finishedAt: this.clock().toISOString()
      });
      this.persist();
      return {
        ...installation, installation, runtime, bbr, deployment, ready: true,
        defaultProtocol: { type: "shadowsocks", port: profile.port },
        warnings: [...this.state.warnings]
      };
    } catch (error) {
      // A failed publication already restores the previous active configuration.
      // Keep the now-active config and firewall if only its later health check failed.
      if (!published) {
        if (changedProfile) {
          try { this.store.updateHostProtocolConfig("local", "shadowsocks", originalProfile); }
          catch (rollbackError) { this.state.warnings.push(`协议配置恢复失败：${rollbackError.message}`); }
        }
        for (const firewall of firewalls.reverse()) {
          try { await firewall.rollback?.(); }
          catch (rollbackError) { this.state.warnings.push(`防火墙恢复失败：${rollbackError.message}`); }
        }
      }
      this.step(this.state.stage, "failed", error.message);
      Object.assign(this.state, {
        status: "failed", ready: false,
        error: { code: error.code || "RUNTIME_SETUP_FAILED", message: error.message },
        finishedAt: this.clock().toISOString()
      });
      this.persist();
      throw error;
    }
  }
}
