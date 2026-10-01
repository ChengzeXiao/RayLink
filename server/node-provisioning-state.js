import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { normalizeNodeDomain } from "./node-domains.js";

function failure(code, message, statusCode = 422) {
  return Object.assign(new Error(message), { code, statusCode });
}

function text(value, label, max = 128) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw failure("INVALID_PROVISIONING_INPUT", `${label}格式不正确`);
  }
  return value.trim();
}

export function normalizeProvisioningEndpoint(host, port = 22) {
  host = text(host, "Host IP");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const family = isIP(host);
  if (!family || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw failure("INVALID_PROVISIONING_INPUT", "请输入有效的 Host IP 和 SSH 端口");
  }
  if (family === 6) {
    host = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    const mapped = host.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
    if (mapped) {
      const upper = Number.parseInt(mapped[1], 16), lower = Number.parseInt(mapped[2], 16);
      host = [upper >> 8, upper & 255, lower >> 8, lower & 255].join(".");
    }
  }
  return { host, port };
}

function hostKey(value) {
  if (typeof value !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value)) throw failure("INVALID_PROVISIONING_INPUT", "SSH Host Key 指纹格式不正确");
  return value;
}

function settings(input = {}) {
  const target = normalizeProvisioningEndpoint(input.host, input.port);
  const username = text(input.username, "SSH 用户", 64);
  const region = text(input.region ?? "global", "区域", 32).toLowerCase();
  const preset = input.preset ?? "ip-stable";
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(username) || !/^[a-z0-9-]{2,32}$/.test(region) || preset !== "ip-stable") {
    throw failure("INVALID_PROVISIONING_INPUT", "SSH 用户、区域或协议预设格式不正确");
  }
  // Never spread input: the caller holds credentials only for the active attempt.
  const options = {};
  if (input.domainMode !== undefined) {
    if (!["auto", "existing", "none"].includes(input.domainMode)) throw failure("INVALID_PROVISIONING_INPUT", "请选择有效的域名配置方式");
    options.domainMode = input.domainMode;
    if (input.domainMode === "existing") options.endpointDomain = normalizeNodeDomain(input.endpointDomain);
    else if (input.endpointDomain) throw failure("INVALID_PROVISIONING_INPUT", "手动域名需选择已解析域名模式");
  } else if (input.endpointDomain) throw failure("INVALID_PROVISIONING_INPUT", "手动域名需选择已解析域名模式");
  if (input.inheritProtocols !== undefined) {
    if (typeof input.inheritProtocols !== "boolean") throw failure("INVALID_PROVISIONING_INPUT", "继承协议选项须为布尔值");
    options.inheritProtocols = input.inheritProtocols;
  }
  return { ...target, username, name: text(input.name ?? `VPS-${target.host}`, "Host 名称", 80), region, preset, ...options };
}

function view(row) {
  if (!row) return null;
  return { id: row.id, adminId: row.admin_id, requestId: row.request_id, input: JSON.parse(row.input_json),
    hostId: row.host_id, status: row.status, stage: row.stage, progress: row.progress, message: row.message,
    errorCode: row.error_code, hostKeyFingerprint: row.host_key_fingerprint, createdAt: row.created_at,
    updatedAt: row.updated_at, completedAt: row.completed_at, result: JSON.parse(row.result_json) };
}

const transitions = {
  queued: new Set(["queued", "running", "failed", "interrupted"]),
  running: new Set(["running", "succeeded", "failed", "interrupted"]),
  succeeded: new Set(["succeeded"]), failed: new Set(["failed"]), interrupted: new Set(["interrupted"])
};
const terminal = new Set(["succeeded", "failed", "interrupted"]);

function safeResult(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw failure("INVALID_PROVISIONING_INPUT", "任务结果格式不正确");
  const result = {};
  if (input.endpointDomain) result.endpointDomain = normalizeNodeDomain(input.endpointDomain);
  if (input.skippedProtocols !== undefined) {
    if (!Array.isArray(input.skippedProtocols) || input.skippedProtocols.length > 32) throw failure("INVALID_PROVISIONING_INPUT", "跳过协议列表无效");
    result.skippedProtocols = input.skippedProtocols.map((entry) => ({ type: text(entry.type, "协议", 64), reason: text(entry.reason, "原因", 64) }));
  }
  for (const key of ["hostId", "deploymentId", "runtimeVersion", "nodeVersion", "usageMeteringStatus"]) {
    if (input[key] !== undefined) result[key] = text(input[key], key);
  }
  for (const key of ["eligibleUserCount", "verifiedUserCount"]) {
    if (input[key] === undefined) continue;
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) throw failure("INVALID_PROVISIONING_INPUT", "验证用户数量格式不正确");
    result[key] = input[key];
  }
  if (input.subscriptionStatus !== undefined) {
    if (!["verified", "awaiting-users"].includes(input.subscriptionStatus)) throw failure("INVALID_PROVISIONING_INPUT", "订阅验证状态格式不正确");
    result.subscriptionStatus = input.subscriptionStatus;
  }
  if (input.subscriptionVerified !== undefined) {
    if (typeof input.subscriptionVerified !== "boolean") throw failure("INVALID_PROVISIONING_INPUT", "订阅验证结果格式不正确");
    result.subscriptionVerified = input.subscriptionVerified;
  }
  if (input.protocols !== undefined) {
    if (!Array.isArray(input.protocols) || input.protocols.length > 32) throw failure("INVALID_PROVISIONING_INPUT", "协议列表格式不正确");
    result.protocols = input.protocols.map((value) => text(value, "协议", 64));
  }
  if (input.protocolChecks !== undefined) {
    if (!Array.isArray(input.protocolChecks) || input.protocolChecks.length > 32) throw failure("INVALID_PROVISIONING_INPUT", "协议检查格式不正确");
    result.protocolChecks = input.protocolChecks.map((check) => {
      const safe = { type: text(check?.type, "协议", 64), state: text(check?.state, "检查状态", 64) };
      if (check.latencyMs !== undefined) {
        if (check.latencyMs !== null && (!Number.isFinite(check.latencyMs) || check.latencyMs < 0)) throw failure("INVALID_PROVISIONING_INPUT", "延时格式不正确");
        safe.latencyMs = check.latencyMs;
      }
      return safe;
    });
  }
  return result;
}

export class ProvisioningState {
  constructor(store) {
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS node_provisioning_jobs (
      id TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id), request_id TEXT NOT NULL,
      input_json TEXT NOT NULL, input_hash TEXT NOT NULL, target_host TEXT NOT NULL, target_port INTEGER NOT NULL,
      host_id TEXT, status TEXT NOT NULL, stage TEXT NOT NULL, progress INTEGER NOT NULL,
      message TEXT NOT NULL, error_code TEXT, host_key_fingerprint TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, result_json TEXT NOT NULL,
      UNIQUE(admin_id, request_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS node_provisioning_active_target
      ON node_provisioning_jobs(target_host, target_port) WHERE status IN ('queued', 'running');
    CREATE TABLE IF NOT EXISTS node_provisioning_host_keys (
      target_host TEXT NOT NULL, target_port INTEGER NOT NULL, fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(target_host, target_port)
    );
    CREATE TABLE IF NOT EXISTS node_provisioning_retries (
      admin_id TEXT NOT NULL REFERENCES admins(id), request_id TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES node_provisioning_jobs(id), created_at TEXT NOT NULL,
      PRIMARY KEY(admin_id, request_id)
    );`);
  }

  create({ adminId, requestId, input } = {}) {
    adminId = text(adminId, "管理员 ID");
    requestId = text(requestId, "请求 ID");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) throw failure("INVALID_PROVISIONING_INPUT", "请求 ID 格式不正确");
    const safe = settings(input);
    const serialized = JSON.stringify(safe);
    const fingerprint = createHash("sha256").update(serialized).digest("hex");
    const existing = this.db.prepare("SELECT * FROM node_provisioning_jobs WHERE admin_id = ? AND request_id = ?").get(adminId, requestId);
    if (existing) {
      if (existing.input_hash !== fingerprint) throw failure("PROVISIONING_REQUEST_CONFLICT", "请求编号已用于其他接入参数", 409);
      return { job: view(existing), created: false };
    }
    this.assertTargetAvailable(safe.host, safe.port);
    const unfinished = this.db.prepare("SELECT id FROM node_provisioning_jobs WHERE target_host = ? AND target_port = ? AND status IN ('failed', 'interrupted') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(safe.host, safe.port);
    if (unfinished) throw Object.assign(failure("PROVISIONING_RETRY_REQUIRED", "该 Host 已有失败或中断的任务，请重新提供凭据并重试原任务", 409), { jobId: unfinished.id });
    const now = new Date().toISOString(), id = randomUUID();
    try {
      this.db.prepare(`INSERT INTO node_provisioning_jobs
        (id, admin_id, request_id, input_json, input_hash, target_host, target_port, status, stage, progress, message, created_at, updated_at, result_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 0, '等待接入', ?, ?, '{}')`).run(id, adminId, requestId, serialized, fingerprint, safe.host, safe.port, now, now);
    } catch (error) {
      this.assertTargetAvailable(safe.host, safe.port);
      throw error;
    }
    return { job: this.get(id), created: true };
  }

  get(id) { return view(this.db.prepare("SELECT * FROM node_provisioning_jobs WHERE id = ?").get(id)); }

  update(id, patch = {}) {
    const current = this.get(id);
    if (!current) throw failure("PROVISIONING_NOT_FOUND", "接入任务不存在", 404);
    if (patch.hostId !== undefined && current.hostId && patch.hostId !== current.hostId) throw failure("PROVISIONING_HOST_CONFLICT", "接入任务不能更换已绑定的 Host", 409);
    const status = patch.status ?? current.status;
    if (!transitions[current.status].has(status)) throw failure("PROVISIONING_INVALID_TRANSITION", "任务状态不允许此变更", 409);
    const progress = patch.progress ?? current.progress;
    if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw failure("INVALID_PROVISIONING_INPUT", "进度须为 0–100 的整数");
    const stage = patch.stage === undefined ? current.stage : text(patch.stage, "阶段", 64);
    const message = patch.message === undefined ? current.message : text(patch.message, "状态文案", 300);
    const errorCode = patch.errorCode === undefined ? current.errorCode : patch.errorCode;
    if (errorCode !== null && (typeof errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(errorCode))) throw failure("INVALID_PROVISIONING_INPUT", "错误代码格式不正确");
    const hostId = patch.hostId === undefined ? current.hostId : text(patch.hostId, "Host ID");
    const result = patch.result === undefined ? current.result : safeResult(patch.result);
    const fingerprint = patch.hostKeyFingerprint === undefined ? current.hostKeyFingerprint : hostKey(patch.hostKeyFingerprint);
    if (fingerprint && this.readFingerprint(current.input.host, current.input.port) !== fingerprint) throw failure("SSH_HOST_KEY_CHANGED", "SSH Host Key 与已固定指纹不一致", 409);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE node_provisioning_jobs SET host_id = ?, status = ?, stage = ?, progress = ?, message = ?, error_code = ?, host_key_fingerprint = ?, updated_at = ?, completed_at = ?, result_json = ? WHERE id = ?`).run(
      hostId, status, stage, progress, message, errorCode, fingerprint, now, terminal.has(status) ? current.completedAt || now : null, JSON.stringify(result), id
    );
    return this.get(id);
  }

  retry(id, identity) {
    if (identity) {
      const adminId = text(identity.adminId, "管理员 ID");
      const requestId = text(identity.requestId, "请求 ID");
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) throw failure("INVALID_PROVISIONING_INPUT", "请求 ID 格式不正确");
      this.db.exec("SAVEPOINT provisioning_retry");
      try {
        const previous = this.db.prepare("SELECT job_id FROM node_provisioning_retries WHERE admin_id = ? AND request_id = ?").get(adminId, requestId);
        if (previous && previous.job_id !== id) throw failure("PROVISIONING_REQUEST_CONFLICT", "请求编号已用于其他接入任务", 409);
        if (previous) {
          this.db.exec("RELEASE provisioning_retry");
          return { ...this.get(id), retryReplayed: true };
        }
        const job = this.retry(id);
        this.db.prepare("INSERT INTO node_provisioning_retries(admin_id, request_id, job_id, created_at) VALUES (?, ?, ?, ?)").run(adminId, requestId, id, new Date().toISOString());
        this.db.exec("RELEASE provisioning_retry");
        return { ...job, retryReplayed: false };
      } catch (error) {
        this.db.exec("ROLLBACK TO provisioning_retry; RELEASE provisioning_retry");
        throw error;
      }
    }
    const current = this.get(id);
    if (!current) throw failure("PROVISIONING_NOT_FOUND", "接入任务不存在", 404);
    if (!["failed", "interrupted"].includes(current.status)) throw failure("PROVISIONING_RETRY_NOT_ALLOWED", "仅失败或中断的任务可显式重试", 409);
    this.assertTargetAvailable(current.input.host, current.input.port, id);
    this.db.prepare(`UPDATE node_provisioning_jobs SET status = 'queued', stage = 'queued', progress = 0,
      message = '等待重新接入', error_code = NULL, completed_at = NULL, updated_at = ?, result_json = '{}' WHERE id = ?`).run(new Date().toISOString(), id);
    return this.get(id);
  }

  interruptPending() {
    const now = new Date().toISOString();
    return Number(this.db.prepare(`UPDATE node_provisioning_jobs SET status = 'interrupted',
      message = '服务重启中断接入；请重新提供 SSH 凭据并显式重试', error_code = 'PROVISIONING_INTERRUPTED',
      updated_at = ?, completed_at = ? WHERE status IN ('queued', 'running')`).run(now, now).changes);
  }

  readFingerprint(host, port) {
    const target = normalizeProvisioningEndpoint(host, port);
    return this.db.prepare("SELECT fingerprint FROM node_provisioning_host_keys WHERE target_host = ? AND target_port = ?").get(target.host, target.port)?.fingerprint || null;
  }

  pinFingerprint(host, port, fingerprint) {
    const target = normalizeProvisioningEndpoint(host, port);
    fingerprint = hostKey(fingerprint);
    this.db.prepare("INSERT OR IGNORE INTO node_provisioning_host_keys(target_host, target_port, fingerprint, created_at) VALUES (?, ?, ?, ?)").run(target.host, target.port, fingerprint, new Date().toISOString());
    if (this.readFingerprint(target.host, target.port) !== fingerprint) throw failure("SSH_HOST_KEY_CHANGED", "SSH Host Key 已变化，请先人工确认服务器身份", 409);
    return fingerprint;
  }

  assertTargetAvailable(host, port, exceptId = "") {
    const active = this.db.prepare("SELECT id FROM node_provisioning_jobs WHERE target_host = ? AND target_port = ? AND status IN ('queued', 'running') AND id != ?").get(host, port, exceptId);
    if (active) throw Object.assign(failure("PROVISIONING_TARGET_BUSY", "该 Host SSH 端点已有接入任务", 409), { jobId: active.id });
  }

  list(limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw failure("INVALID_PROVISIONING_INPUT", "列表数量须为 1–500 的整数");
    return this.db.prepare("SELECT * FROM node_provisioning_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit).map(view);
  }
}
