import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { platform as currentPlatform } from "node:os";
import { dirname } from "node:path";

import { LocalPortManager, UfwFirewallManager, protocolActivationPolicy } from "./protocol-activation.js";
import { APPROVED_METERED_RUNTIME_VERSION, compareVersions } from "./singbox/installer.js";

const stepLabels = [
  ["install", "安装计量版 sing-box"],
  ["bbr", "配置 BBR 与 fq 队列"],
  ["protocol", "配置入口协议与防火墙"],
  ["publish", "校验并发布 Runtime 配置"],
  ["health", "验证服务与协议监听"]
];

const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");

function setupError(code, message, statusCode = 500) {
  return Object.assign(new Error(message), { code, statusCode });
}

function listenerNetworks(inbound, policy) {
  if (!inbound.listen_port) return [];
  if (inbound.transport?.type === "quic" || policy.network === "udp") return ["udp"];
  // These inbounds bind both networks when network is omitted. SOCKS/Mixed
  // negotiate UDP associations dynamically, rather than on this listening port.
  if (["shadowsocks", "naive", "direct", "tproxy"].includes(inbound.type)) {
    return ["tcp", "udp"].includes(inbound.network) ? [inbound.network] : ["tcp", "udp"];
  }
  return [policy.network];
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
        this.state.steps = saved.steps.map(step => ({ ...step,
          label: stepLabels.find(([id]) => id === step.id)?.[1] || step.label,
          ...(step.message === "配置 Shadowsocks 与防火墙"
            ? { message: "上次已配置默认入口；可重新检查全部已启用协议" } : {}) }));
        if (this.state.status === "succeeded" && this.state.message === "Runtime、Shadowsocks 与 BBR 已配置并运行") {
          this.state.message = "上次 Runtime 安装已完成；可重新检查全部已启用协议与防火墙";
        }
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
      const config = this.runtimeManager.compileHostRuntimeConfig("local");
      const protocols = this.store.listHostProtocolConfigs("local").filter(entry => entry.enabled).map(entry => {
        const tag = entry.type === "shadowsocks" ? "managed-shadowsocks" : `raylink-${entry.type}`;
        const inbound = config.inbounds.find(candidate => candidate.tag === tag);
        if (!inbound) throw setupError("PROTOCOL_NOT_CONFIGURED", `生成的配置中没有 ${entry.type} 入站`);
        const policy = protocolActivationPolicy(entry.type);
        return { profile: entry, networks: listenerNetworks(inbound, policy), policy, firewalls: [] };
      });
      const openedRules = new Map();
      const openRule = async (rule) => {
        const key = `${rule.port}/${rule.network}`;
        if (!openedRules.has(key)) {
          const firewall = await this.firewallManager.open(rule);
          openedRules.set(key, firewall);
          firewalls.push(firewall);
        }
        return openedRules.get(key);
      };
      for (const protocol of protocols) {
        const loopback = loopbackAddresses.check(protocol.profile.listen, isIP(protocol.profile.listen) === 6 ? "ipv6" : "ipv4");
        if (protocol.policy.exposure !== "public" || loopback) continue;
        for (const network of protocol.networks) {
          protocol.firewalls.push(await openRule({ port: protocol.profile.port, network }));
        }
        if (protocol.profile.tls.mode === "acme") {
          protocol.firewalls.push(await openRule({ port: 80, network: "tcp", purpose: "acme-http-01" }));
        }
      }
      const protocolNames = protocols.map(entry => entry.profile.type).join("、");
      this.step("protocol", "succeeded", `保留并配置已启用入口：${protocolNames}`);

      this.step("publish", "running");
      const deployment = await this.runtimeManager.publish(publisherAdminId, { reason: "automatic-runtime-setup" });
      published = true;
      this.step("publish", "succeeded");

      this.step("health", "running");
      for (const protocol of protocols) {
        for (const network of protocol.networks) {
          await this.portManager.waitForListening({ listen: protocol.profile.listen, port: protocol.profile.port, network });
        }
      }
      const runtime = await this.runtimeManager.status();
      if (runtime.mode !== "systemd" || runtime.state !== "running") {
        throw setupError("RUNTIME_NOT_RUNNING", "配置已发布，但 sing-box 服务未确认运行");
      }
      const checkedAt = this.clock().toISOString();
      for (const protocol of protocols.filter(entry => entry.networks.length)) {
        this.store.setProtocolActivation("local", protocol.profile.type, {
          state: "port-listening", progress: 100, port: protocol.profile.port,
          network: protocol.networks.join(","), firewallManaged: protocol.firewalls.some(item => item.managed),
          publicCheck: { reachable: null, checkedAt, reason: protocol.policy.exposure === "public"
            ? "本机服务与端口已验证，等待公网协议探测" : "本机监听已验证，此入口不执行公网探测" },
          updatedAt: checkedAt
        });
      }
      this.step("health", "succeeded", `服务运行与已启用协议监听检查通过：${protocolNames}`);
      Object.assign(this.state, {
        status: "succeeded", ready: true,
        message: this.state.warnings.length ? "Runtime 与入口协议已运行，网络加速存在待处理项" : "Runtime、已启用入口协议与 BBR 已配置并运行",
        finishedAt: this.clock().toISOString()
      });
      this.persist();
      return {
        ...installation, installation, runtime, bbr, deployment, ready: true,
        defaultProtocol: { type: "shadowsocks", port: profile.port },
        protocols: protocols.map(entry => ({ type: entry.profile.type, port: entry.profile.port, networks: entry.networks })),
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
