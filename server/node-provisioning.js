import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ProvisioningState, normalizeProvisioningEndpoint } from "./node-provisioning-state.js";
import { SshBootstrap } from "./ssh-bootstrap.js";

const fail = (code, message, statusCode = 422) => Object.assign(new Error(message), { code, statusCode });
const messages = {
  SSH_AUTH_FAILED: "SSH 认证失败，请检查登录凭据后重试",
  SSH_AUTHENTICATION_FAILED: "SSH 认证失败，请检查登录凭据后重试",
  SSH_HOST_KEY_MISMATCH: "SSH 主机指纹已变化，请人工核实服务器身份",
  SSH_HOST_KEY_CHANGED: "SSH 主机指纹已变化，请人工核实服务器身份",
  SSH_CONNECT_TIMEOUT: "SSH 连接超时，请检查地址、端口和服务器防火墙",
  SSH_CONNECTION_FAILED: "SSH 连接失败，请检查登录地址及认证信息",
  SSH_PRIVILEGE_REQUIRED: "安装需要 root 或 sudo 权限",
  SSH_EXISTING_NODE_CONFLICT: "服务器已有不匹配的节点，请核对原控制面和节点身份",
  SSH_COMMAND_TIMEOUT: "远程执行超时；可重试以继续同一节点的安装",
  SSH_PREFLIGHT_FAILED: "服务器预检失败，请检查 Linux、systemd、现有 Runtime 和控制面 HTTPS 可达性",
  SSH_PREFLIGHT_INVALID: "服务器未返回受支持的系统及身份信息",
  SSH_INSTALL_FAILED: "远程安装失败，请检查服务器的软件源和控制面下载可达性后重试",
  SSH_CONNECTION_CLOSED: "SSH 连接中断，可重试继续接入",
  SSH_EXEC_FAILED: "远程命令执行失败，请检查系统权限和安装依赖",
  SSH_OUTPUT_LIMIT: "远程输出超过限制，接入已停止",
  SSH_UNSUPPORTED_OS: "服务器需要 Linux 系统",
  SSH_SYSTEMD_REQUIRED: "服务器需要运行 systemd",
  SSH_UNMANAGED_RUNTIME: "服务器已有非 RayLink 管理的 sing-box，请先处理服务冲突",
  SSH_EXISTING_IDENTITY_UNREADABLE: "无法读取服务器上已有 Node 的身份，未覆盖安装",
  SSH_INSTALLER_UNAVAILABLE: "服务器无法通过 HTTPS 获取控制面安装程序",
  SSH_REMOTE_FAILED: "远程预检或安装失败，请检查权限、软件源及安装状态后重试",
  PROVISIONING_IDENTITY_CONFLICT: "服务器与现有节点身份不匹配，未覆盖原节点",
  PROVISIONING_ENROLLMENT_TIMEOUT: "等待 Node 注册超时，请检查服务器到控制面的 HTTPS 连接后重试",
  PROVISIONING_CAPABILITIES: "请升级 Node 与计量 Runtime；需要受支持的 Node、sing-box 1.14.x 和加密配置能力",
  PROVISIONING_APPLY_TIMEOUT: "等待配置发布超时，请查看节点任务后重试",
  PROVISIONING_APPLY_FAILED: "节点配置发布失败，请检查协议状态后重试",
  PROVISIONING_METERING_TIMEOUT: "配置已发布，但运行状态或流量计量尚未就绪",
  PROVISIONING_CONNECTIVITY: "配置已发布，但协议公网验证未通过，请检查云安全组和网络后重试",
  PROVISIONING_SUBSCRIPTION: "节点已运行，但订阅内容验证未通过，请重试",
  PROVISIONING_FAILED: "接入未完成，请检查节点状态后重试",
  PROVISIONING_INTERRUPTED: "接入已中断；可继续同一任务，未完成 SSH 安装时需重新提供凭据"
};

function credentials(input, optional = false) {
  const result = {};
  for (const [key, max] of [["password", 4096], ["privateKey", 65536], ["passphrase", 4096], ["sudoPassword", 4096]]) {
    if (input[key] === undefined || input[key] === "") continue;
    if (typeof input[key] !== "string" || input[key].length > max || input[key].includes("\0")) throw fail("INVALID_SSH_CREDENTIALS", "SSH 凭据格式不正确");
    result[key] = input[key];
  }
  if (Boolean(result.password) === Boolean(result.privateKey) && !(optional && !result.password && !result.privateKey)) {
    throw fail("INVALID_SSH_CREDENTIALS", "请提供密码或私钥中的一种认证方式");
  }
  return result;
}

function origin(value) {
  let url;
  try { url = new URL(value); } catch { /* invalid below */ }
  if (!url || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname)) {
    throw fail("PROVISIONING_PUBLIC_ORIGIN", "请先配置服务器可访问的控制面 HTTPS 根地址");
  }
  return url.origin;
}

function validateTarget(input) {
  const { host } = normalizeProvisioningEndpoint(input.host, input.port);
  const octets = host.split(".").map(Number);
  if ((isIP(host) === 4 && (octets[0] === 0 || octets[0] === 127 || octets[0] >= 224 || (octets[0] === 169 && octets[1] === 254)))
    || (isIP(host) === 6 && (host === "::" || host === "::1" || /^(?:fe[89ab][0-9a-f]|ff[0-9a-f]{2}):/i.test(host)))) {
    throw fail("INVALID_PROVISIONING_INPUT", "请输入可连接的服务器 IP，不能使用本机、链路本地或组播地址");
  }
}

function eligible(user, host) {
  return ["active", "warning"].includes(user.state) && user.portalStatus === "active"
    && user.usedGb < user.quotaGb && new Date(`${user.expiresAt}T23:59:59.999Z`) >= new Date()
    && (user.nodeScope.includes("all") || user.nodeScope.includes(host.region));
}

export class NodeProvisioning {
  constructor({ store, sshBootstrap = new SshBootstrap(), publicOrigin, activate, measure, buildClientConfig, acceptedNodeVersions, pollMs = 1000, waitMs = 5 * 60_000 }) {
    Object.assign(this, { store, sshBootstrap, publicOrigin, activate, measure, buildClientConfig, acceptedNodeVersions, pollMs, waitMs });
    this.state = new ProvisioningState(store);
    this.state.interruptPending();
    this.running = new Map();
    this.closed = false;
  }

  start(input, adminId) {
    origin(this.publicOrigin());
    validateTarget(input);
    const secret = credentials(input);
    // Replay is permitted while another job is running; no credential is retained.
    const previous = this.store.db.prepare("SELECT id FROM node_provisioning_jobs WHERE admin_id = ? AND request_id = ?").get(adminId, String(input.requestId || ""));
    if (!previous) this.assertCapacity();
    const { job, created } = this.state.create({ adminId, requestId: input.requestId, input: { ...input, username: input.username || "root" } });
    if (created) this.launch(job, secret);
    return job;
  }

  retry(id, input, adminId) {
    origin(this.publicOrigin());
    const previous = this.store.db.prepare("SELECT job_id FROM node_provisioning_retries WHERE admin_id = ? AND request_id = ?").get(adminId, String(input.requestId || ""));
    if (previous) {
      if (previous.job_id !== id) throw fail("PROVISIONING_REQUEST_CONFLICT", "请求编号已用于其他接入任务", 409);
      return this.get(id);
    }
    this.assertCapacity();
    const job = this.get(id);
    validateTarget(job.input);
    const secret = credentials(input, true);
    const host = job.hostId && this.store.getHost(job.hostId);
    if (!(host?.enrolledAt && this.fresh(host)) && !secret.password && !secret.privateKey) throw fail("INVALID_SSH_CREDENTIALS", "请重新填写 SSH 密码或私钥以继续安装");
    const { retryReplayed, ...queued } = this.state.retry(id, { adminId, requestId: input.requestId });
    if (!retryReplayed) this.launch(queued, secret, adminId);
    return queued;
  }

  get(id) {
    const job = this.state.get(id);
    if (!job) throw fail("PROVISIONING_NOT_FOUND", "接入任务不存在", 404);
    return job;
  }
  list() { return this.state.list(); }
  assertCapacity() {
    if (this.closed || this.running.size) throw fail("PROVISIONING_BUSY", "已有节点正在接入，请完成后再试", 409);
  }
  fresh(host) { return host?.lastSeenAt && Date.now() - new Date(host.lastSeenAt).getTime() <= 30_000; }

  launch(job, secret, adminId = job.adminId) {
    const controller = new AbortController();
    const promise = this.run(job, secret, adminId, controller.signal).catch((error) => {
      const code = controller.signal.aborted ? "PROVISIONING_INTERRUPTED" : Object.hasOwn(messages, error.code) ? error.code : "PROVISIONING_FAILED";
      this.state.update(job.id, { status: controller.signal.aborted ? "interrupted" : "failed", errorCode: code, message: messages[code] });
    }).finally(() => this.running.delete(job.id));
    this.running.set(job.id, { controller, promise });
  }

  async waitFor(check, code, signal) {
    const deadline = Date.now() + this.waitMs;
    while (true) {
      signal.throwIfAborted();
      const value = await check();
      if (value) return value;
      if (Date.now() >= deadline) throw fail(code, messages[code]);
      await delay(this.pollMs, undefined, { signal });
    }
  }

  async run(job, secret, adminId, signal) {
    const update = (patch) => this.state.update(job.id, patch);
    let host = job.hostId && this.store.getHost(job.hostId);
    update({ status: "running", stage: "connecting", progress: 5, message: "连接 SSH 并核验服务器身份" });
    let session;
    try {
      if (job.hostId && (!host || host.kind !== "remote" || host.address !== job.input.host)) throw fail("PROVISIONING_IDENTITY_CONFLICT", messages.PROVISIONING_IDENTITY_CONFLICT);
      if (!host?.enrolledAt || !this.fresh(host)) {
        const server = origin(this.publicOrigin());
        const expectedFingerprint = this.state.readFingerprint(job.input.host, job.input.port);
        session = await this.sshBootstrap.connect({ ...job.input, ...secret, sudoPassword: secret.sudoPassword || secret.password }, { ...(expectedFingerprint ? { expectedFingerprint } : {}), signal });
        this.state.pinFingerprint(job.input.host, job.input.port, session.fingerprint);
        update({ hostKeyFingerprint: session.fingerprint, stage: "preflight", progress: 10, message: "检查 Linux、systemd、权限和已有节点" });
        const { existing } = await session.preflight({ server, hostId: host?.id });
        let enrollmentToken;
        if (existing) {
          const known = this.store.getHost(existing.hostId);
          if (existing.server !== server || !known || known.kind !== "remote" || known.address !== job.input.host || (host && host.id !== known.id)) throw fail("PROVISIONING_IDENTITY_CONFLICT", messages.PROVISIONING_IDENTITY_CONFLICT);
          host = known;
          update({ hostId: host.id });
        } else {
          if (host?.enrolledAt || (!host && this.store.listHosts().some((entry) => entry.address === job.input.host))) throw fail("PROVISIONING_IDENTITY_CONFLICT", messages.PROVISIONING_IDENTITY_CONFLICT);
          this.store.db.exec("SAVEPOINT bind_provision_host");
          try {
            if (host) enrollmentToken = this.store.rotateNodeEnrollmentToken(host.id).enrollmentToken;
            else {
              const created = this.store.createRemoteHost({ name: job.input.name, address: job.input.host, region: job.input.region });
              host = created.host; enrollmentToken = created.enrollmentToken;
            }
            update({ hostId: host.id });
            this.store.db.exec("RELEASE bind_provision_host");
          } catch (error) { this.store.db.exec("ROLLBACK TO bind_provision_host; RELEASE bind_provision_host"); throw error; }
        }
        update({ stage: "installing", progress: 20, message: "安装并启动 Node 和计量 Runtime" });
        await session.install({ server, enrollmentToken, hostId: host.id, onStage: (stage) => {
          const stages = { dependencies: [25, "自动安装系统依赖"], download: [30, "下载并校验安装程序"], install: [40, "安装 Node 与 sing-box"], complete: [50, "安装结束，等待节点注册"] };
          if (stages[stage]) update({ stage: "installing", progress: stages[stage][0], message: stages[stage][1] });
        } });
      }
    } finally {
      session?.close();
      session = null;
      for (const key of Object.keys(secret)) delete secret[key];
    }
    update({ stage: "enrolling", progress: 55, message: "等待 Node 注册和能力上报" });
    host = await this.waitFor(() => {
      const current = this.store.getHost(host.id);
      return current?.enrolledAt && this.fresh(current) && current;
    }, "PROVISIONING_ENROLLMENT_TIMEOUT", signal);
    if (!/^1\.14\./.test(host.runtimeVersion || "") || !host.buildTags.includes("with_v2ray_api") || !host.assetEncryptionReady
      || (this.acceptedNodeVersions && !this.acceptedNodeVersions.includes(host.agentVersion))) throw fail("PROVISIONING_CAPABILITIES", messages.PROVISIONING_CAPABILITIES);
    update({ stage: "publishing", progress: 65, message: "启用稳定协议、配置端口并发布用户配置" });
    let deployment;
    await this.waitFor(async () => {
      try {
        deployment = await this.activate({ hostId: host.id, type: "shadowsocks", adminId, preferredPort: job.input.port === 443 ? 8443 : 443 });
        return true;
      } catch (error) { if (error.code === "RUNTIME_OPERATION_IN_PROGRESS") return false; throw error; }
    }, "PROVISIONING_APPLY_TIMEOUT", signal);
    await this.waitFor(() => {
      const current = this.store.getHost(host.id);
      const activation = current.protocolActivations.find((entry) => entry.type === "shadowsocks");
      if (activation?.state === "failed" && activation.errorCode !== "PROTOCOL_PORT_OCCUPIED") throw fail("PROVISIONING_APPLY_FAILED", messages.PROVISIONING_APPLY_FAILED);
      return ["public-ready", "port-listening"].includes(activation?.state) && current.appliedProtocols.some((profile) => profile.type === "shadowsocks" && profile.enabled && profile.port === activation.port);
    }, "PROVISIONING_APPLY_TIMEOUT", signal);
    update({ stage: "verifying", progress: 80, message: "检查运行状态、流量计量和公网协议连接" });
    host = await this.waitFor(() => {
      const current = this.store.getHost(host.id);
      return this.fresh(current) && current.status === "online" && current.telemetry.serviceStatus === "running" && current.usageMetering.status === "healthy" && current;
    }, "PROVISIONING_METERING_TIMEOUT", signal);
    let measurement;
    await this.waitFor(async () => {
      try { measurement = await this.measure({ hostId: host.id }); return true; }
      catch (error) { if (error.code === "PROTOCOL_LATENCY_IN_PROGRESS") return false; throw error; }
    }, "PROVISIONING_CONNECTIVITY", signal);
    const check = measurement.results.find((entry) => entry.type === "shadowsocks");
    if (check?.status !== "available") throw fail("PROVISIONING_CONNECTIVITY", messages.PROVISIONING_CONNECTIVITY);
    update({ stage: "subscription", progress: 95, message: "验证用户订阅中的节点与协议" });
    const users = this.store.listUsers().filter((user) => eligible(user, host));
    for (const user of users) {
      signal.throwIfAborted();
      const { singBoxConfig } = await this.buildClientConfig(user.id);
      if (!singBoxConfig.outbounds.some((outbound) => outbound.type === "shadowsocks" && outbound.server === host.address && outbound.tag === `raylink-${host.id}-shadowsocks`)) throw fail("PROVISIONING_SUBSCRIPTION", messages.PROVISIONING_SUBSCRIPTION);
    }
    signal.throwIfAborted();
    update({ status: "succeeded", stage: "complete", progress: 100, message: users.length ? "节点接入完成，协议和用户订阅已验证" : "节点已就绪，创建有权限的用户后自动进入订阅", errorCode: null,
      result: { hostId: host.id, ...(deployment?.deployment?.id ? { deploymentId: deployment.deployment.id } : {}), runtimeVersion: host.runtimeVersion, nodeVersion: host.agentVersion,
        protocols: ["shadowsocks"], protocolChecks: [{ type: "shadowsocks", state: check.status, latencyMs: check.latencyMs }], usageMeteringStatus: host.usageMetering.status,
        subscriptionVerified: users.length > 0, subscriptionStatus: users.length ? "verified" : "awaiting-users", eligibleUserCount: users.length, verifiedUserCount: users.length } });
  }

  async close() {
    this.closed = true;
    for (const { controller } of this.running.values()) controller.abort();
    await Promise.allSettled([...this.running.values()].map(({ promise }) => promise));
  }
}
