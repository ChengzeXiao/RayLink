import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isIP } from "node:net";
import { DatabaseSync } from "node:sqlite";

import {
  createRuntimePassword,
  createSessionSecret,
  createShadowsocksKey,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  hashSessionSecret,
  protectSubscriptionSecret,
  revealSubscriptionSecret,
  verifyPassword
} from "./security.js";
import { normalizeCertificateEmail } from "./certificate-settings.js";
import {
  DEFAULT_ROUTING_POLICY,
  normalizeRoutingPolicy
} from "./routing/policy.js";
import {
  assertProtocolSet,
  defaultProtocolConfigs,
  normalizeProtocolConfig,
  normalizeProtocolConfigs
} from "./singbox/protocol-catalog.js";

const LEGACY_CLIENT_FORMATS_JSON = '["mihomo","egern","sing-box"]';

const seedPlans = [
  {
    id: "standard",
    name: "标准访问",
    quotaGb: 120,
    legacyDeviceLimit: 3,
    nodeScope: ["tokyo", "singapore"],
    legacyClientFormatsJson: LEGACY_CLIENT_FORMATS_JSON,
    description: "适合日常办公和开发",
    tone: "standard"
  },
  {
    id: "high-speed",
    name: "高速访问",
    quotaGb: 320,
    legacyDeviceLimit: 5,
    nodeScope: ["all"],
    legacyClientFormatsJson: LEGACY_CLIENT_FORMATS_JSON,
    description: "面向高流量研发团队",
    tone: "premium"
  },
  {
    id: "temporary",
    name: "临时访问",
    quotaGb: 36,
    legacyDeviceLimit: 1,
    nodeScope: ["tokyo"],
    legacyClientFormatsJson: LEGACY_CLIENT_FORMATS_JSON,
    description: "外部协作和短期项目",
    tone: "temporary"
  }
];

const LEGACY_ENTITLEMENT_PLAN_ID = "user-entitlement";
const GIBIBYTE = 1024 ** 3;
const MAX_USAGE_SAMPLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_USAGE_SAMPLE_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ADMIN_ROLES = new Set(["owner", "operator", "support", "auditor"]);

const seedUsers = [
  ["林知夏", "LZ", "lin.zhixia@meridian-log.cn", "active", "active", 74.3, "standard", "2030-10-18"],
  ["岡本和也", "OK", "k.okamoto@hokkaido-ceramics.jp", "active", "warning", 104.8, "standard", "2030-08-04"],
  ["Priya Mehta", "PM", "priya@vantage-bioworks.in", "active", "active", 75.4, "high-speed", "2030-09-01"],
  ["Nia Okafor", "NO", "nia@lagos-fieldworks.ng", "active", "active", 46.8, "standard", "2030-11-23"],
  ["Lars Eriksson", "LE", "lars@nordhavn-data.se", "invited", "disabled", 18.2, "temporary", "2030-07-31"],
  ["陈望舒", "CW", "wangshu@lingnan-studio.cn", "active", "warning", 103.7, "standard", "2030-08-12"]
];

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function domainError(code, message, statusCode = 422) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function validateUserEntitlement({ quotaGb, nodeScope }) {
  if (!Number.isFinite(quotaGb) || quotaGb <= 0) {
    throw domainError("INVALID_QUOTA", "流量额度必须大于 0");
  }
  if (
    !Array.isArray(nodeScope)
    || nodeScope.length === 0
    || nodeScope.some((scope) => !/^(?:all|[a-z0-9][a-z0-9-]{1,31})$/.test(String(scope)))
  ) {
    throw domainError("INVALID_NODE_SCOPE", "节点范围必须使用有效的区域标识");
  }
}

function validateUserPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw domainError("INVALID_PASSWORD", "用户中心密码至少需要 8 位");
  }
  return password;
}

function validateAdminRole(role) {
  const normalized = String(role || "");
  if (!ADMIN_ROLES.has(normalized)) {
    throw domainError("INVALID_ADMIN_ROLE", "管理员角色无效");
  }
  return normalized;
}

function validateAdminUsername(username) {
  const normalized = String(username || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(normalized)) {
    throw domainError(
      "INVALID_ADMIN_USERNAME",
      "管理员用户名需要 3–64 位，只能使用字母、数字、点、横线和下划线"
    );
  }
  return normalized;
}

function validateAdminPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024 || !password.trim()) {
    throw domainError("INVALID_ADMIN_PASSWORD", "管理员密码需要 12–1024 位，且不能全为空白");
  }
  return password;
}

function userFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    initials: row.initials,
    email: row.email,
    portalStatus: row.portal_status,
    state: row.state,
    usedGb: row.used_bytes === null || row.used_bytes === undefined
      ? row.used_gb
      : Number(row.used_bytes) / GIBIBYTE,
    quotaGb: row.quota_gb,
    nodeScope: parseJson(row.node_scope_json, []),
    expiresAt: row.expires_at,
    subscription: {
      publicId: row.subscription_public_id || null,
      configured: Boolean(row.subscription_secret_hash),
      recoverable: Boolean(row.subscription_secret_encrypted)
    }
  };
}

function finiteMetric(value, minimum, maximum) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function normalizeTelemetry(input = {}) {
  const serviceStatus = ["running", "staged", "stopped", "failed", "unknown"].includes(input.serviceStatus)
    ? input.serviceStatus
    : "unknown";
  return {
    cpuPercent: finiteMetric(input.cpuPercent, 0, 100),
    memoryUsedBytes: finiteMetric(input.memoryUsedBytes, 0, Number.MAX_SAFE_INTEGER),
    memoryTotalBytes: finiteMetric(input.memoryTotalBytes, 1, Number.MAX_SAFE_INTEGER),
    diskUsedBytes: finiteMetric(input.diskUsedBytes, 0, Number.MAX_SAFE_INTEGER),
    diskTotalBytes: finiteMetric(input.diskTotalBytes, 1, Number.MAX_SAFE_INTEGER),
    networkRxBytes: finiteMetric(input.networkRxBytes, 0, Number.MAX_SAFE_INTEGER),
    networkTxBytes: finiteMetric(input.networkTxBytes, 0, Number.MAX_SAFE_INTEGER),
    networkRxBps: finiteMetric(input.networkRxBps, 0, Number.MAX_SAFE_INTEGER),
    networkTxBps: finiteMetric(input.networkTxBps, 0, Number.MAX_SAFE_INTEGER),
    serviceStatus
  };
}

function normalizeBbr(input, checkedAt) {
  if (!input || typeof input !== "object") return null;
  const statuses = ["enabled", "available", "unsupported", "unavailable", "failed", "development"];
  let status = statuses.includes(input.status) ? input.status : "unavailable";
  const parameter = (value) => typeof value === "string" && /^[a-z0-9_-]{1,40}$/i.test(value) ? value : null;
  const congestionControl = parameter(input.congestionControl);
  const qdisc = parameter(input.qdisc);
  if (status === "enabled" && (congestionControl !== "bbr" || qdisc !== "fq")) status = "unavailable";
  return { status, congestionControl, qdisc, checkedAt,
    error: input.error ? String(input.error).replace(/[\r\n\t]+/g, " ").slice(0, 400) : null };
}

function hostFromRow(row) {
  const lastSeenAt = row.last_seen_at || null;
  const buildTags = parseJson(row.build_tags_json, []);
  const latestUpgradePayload = parseJson(row.latest_upgrade_payload_json, {}) || {};
  const latestUpgradeEnvelope = parseJson(row.latest_upgrade_result_json, {}) || {};
  const latestUpgradeResult = latestUpgradeEnvelope.result || {};
  const remoteOffline = (row.kind || "local") === "remote"
    && lastSeenAt
    && Date.now() - new Date(lastSeenAt).getTime() > 45_000;
  const usageSupported = buildTags.includes("with_v2ray_api");
  const usageLastSampleAt = row.usage_last_sample_at || null;
  const usageLastErrorAt = row.usage_last_error_at || null;
  const usageErrorIsCurrent = usageLastErrorAt
    && (!usageLastSampleAt || new Date(usageLastErrorAt) > new Date(usageLastSampleAt));
  const usageStale = usageLastSampleAt
    && Date.now() - new Date(usageLastSampleAt).getTime() > 2 * 60_000;
  const usageStatus = !usageSupported
    ? "unsupported"
    : usageErrorIsCurrent
      ? "error"
      : !usageLastSampleAt
        ? "awaiting-sample"
        : usageStale
          ? "stale"
          : "healthy";
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    endpointDomain: row.endpoint_domain || null,
    region: row.region,
    status: remoteOffline ? "offline" : row.status,
    kind: row.kind || "local",
    hostname: row.hostname || null,
    platform: row.platform || null,
    architecture: row.architecture || null,
    agentVersion: row.agent_version || null,
    runtimeVersion: row.runtime_version || null,
    buildTags,
    appliedProtocols: row.applied_protocols_json
      ? normalizeProtocolConfigs(parseJson(row.applied_protocols_json, []))
      : [],
    assetEncryptionReady: Boolean(row.encryption_public_key),
    usageMetering: {
      supported: usageSupported,
      source: usageSupported ? "v2ray-api" : null,
      status: usageStatus,
      lastSampleAt: usageLastSampleAt,
      lastError: usageErrorIsCurrent ? row.usage_last_error || null : null,
      lastErrorAt: usageLastErrorAt
    },
    lastSeenAt,
    enrolledAt: row.enrolled_at || null,
    telemetry: {
      cpuPercent: row.cpu_percent ?? null,
      memoryUsedBytes: row.memory_used_bytes ?? null,
      memoryTotalBytes: row.memory_total_bytes ?? null,
      diskUsedBytes: row.disk_used_bytes ?? null,
      diskTotalBytes: row.disk_total_bytes ?? null,
      networkRxBytes: row.network_rx_bytes ?? null,
      networkTxBytes: row.network_tx_bytes ?? null,
      networkRxBps: row.network_rx_bps ?? null,
      networkTxBps: row.network_tx_bps ?? null,
      serviceStatus: row.service_status || "unknown",
      bbr: parseJson(row.bbr_json, null),
      updatedAt: row.metrics_updated_at || null
    },
    deploymentSync: {
      pendingTaskCount: Number(row.pending_task_count || 0),
      critical: Boolean(row.critical_pending),
      status: Number(row.pending_task_count || 0) > 0
        ? row.critical_pending ? "revocation-pending" : "pending"
        : "current"
    },
    runtimeUpgrade: {
      pending: Number(row.pending_upgrade_count || 0) > 0,
      status: Number(row.pending_upgrade_count || 0) > 0
        ? "pending"
        : row.latest_upgrade_status || "never",
      targetVersion: latestUpgradePayload.targetVersion || null,
      previousVersion: latestUpgradeResult.previousVersion || null,
      runtimeVersion: latestUpgradeResult.runtimeVersion || null,
      rolledBack: typeof latestUpgradeResult.rolledBack === "boolean"
        ? latestUpgradeResult.rolledBack
        : null,
      packageMetadataRestored: typeof latestUpgradeResult.packageMetadataRestored === "boolean"
        ? latestUpgradeResult.packageMetadataRestored
        : null,
      error: latestUpgradeResult.error || null,
      finishedAt: row.latest_upgrade_finished_at || null
    }
  };
}

function normalizedHostInput(input, current = {}) {
  const host = {
    name: input.name === undefined ? current.name : String(input.name).trim(),
    address: input.address === undefined ? current.address : String(input.address).trim(),
    region: input.region === undefined ? current.region : String(input.region).trim()
  };
  if (!host.name || host.name.length > 80) {
    throw domainError("INVALID_HOST_NAME", "主机名称不能为空且不能超过 80 个字符");
  }
  if (!isIP(host.address) && !/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:]+\])$/i.test(host.address)) {
    throw domainError("INVALID_HOST_ADDRESS", "请输入有效的主机域名或 IP 地址");
  }
  if (!/^[a-z0-9-]{2,32}$/i.test(host.region)) {
    throw domainError("INVALID_HOST_REGION", "区域标识格式不正确");
  }
  return host;
}

export class RayLinkStore {
  constructor({
    dbPath,
    adminUsername,
    adminPassword,
    initialHostAddress = "127.0.0.1",
    initialListenPort = 8388,
    seedDemoData = true,
    nodeTaskRetryBaseMs = 60_000,
    setupRequired = false,
    setupTokenHash = "",
    setupTokenExpiresAt = "",
    subscriptionEncryptionKey = "",
    clock = () => new Date()
  }) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // Configure the busy handler before any pragma that may need to upgrade
    // the database lock. Multiple control-plane workers can open the same
    // database while another process is finishing a transaction.
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.lastTelemetryPruneAt = 0;
    this.nodeTaskRetryBaseMs = Math.max(0, Number(nodeTaskRetryBaseMs) || 0);
    this.subscriptionEncryptionKey = subscriptionEncryptionKey || adminPassword;
    this.clock = clock;
    this.migrate();
    this.seed({ adminUsername, adminPassword, initialHostAddress, initialListenPort, seedDemoData });
    this.initializeSetup({ setupRequired, setupTokenHash, setupTokenExpiresAt });
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'owner',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        secret_hash TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id TEXT REFERENCES admins(id) ON DELETE SET NULL,
        actor_username TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_created
      ON audit_events(created_at DESC);
      CREATE TABLE IF NOT EXISTS user_sessions (
        secret_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        quota_gb REAL NOT NULL CHECK (quota_gb > 0),
        device_limit INTEGER NOT NULL CHECK (device_limit > 0),
        node_scope_json TEXT NOT NULL,
        client_formats_json TEXT NOT NULL,
        description TEXT NOT NULL,
        tone TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        initials TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        portal_status TEXT NOT NULL CHECK (portal_status IN ('active', 'invited')),
        state TEXT NOT NULL CHECK (state IN ('active', 'warning', 'disabled')),
        used_gb REAL NOT NULL DEFAULT 0 CHECK (used_gb >= 0),
        used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
        plan_id TEXT NOT NULL REFERENCES plans(id),
        quota_gb REAL NOT NULL CHECK (quota_gb > 0),
        device_limit INTEGER NOT NULL CHECK (device_limit > 0),
        node_scope_json TEXT NOT NULL,
        client_formats_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        runtime_uuid TEXT NOT NULL UNIQUE,
        runtime_password TEXT NOT NULL,
        subscription_public_id TEXT,
        subscription_secret_hash TEXT,
        subscription_secret_encrypted TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        region TEXT NOT NULL,
        status TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'local',
        enrollment_secret_hash TEXT,
        node_secret_hash TEXT,
        hostname TEXT,
        platform TEXT,
        architecture TEXT,
        agent_version TEXT,
        runtime_version TEXT,
        build_tags_json TEXT NOT NULL DEFAULT '[]',
        applied_protocols_json TEXT,
        encryption_public_key TEXT,
        usage_last_sample_at TEXT,
        usage_last_error TEXT,
        usage_last_error_at TEXT,
        last_seen_at TEXT,
        enrolled_at TEXT,
        cpu_percent REAL,
        memory_used_bytes INTEGER,
        memory_total_bytes INTEGER,
        disk_used_bytes INTEGER,
        disk_total_bytes INTEGER,
        network_rx_bytes INTEGER,
        network_tx_bytes INTEGER,
        network_rx_bps REAL,
        network_tx_bps REAL,
        service_status TEXT,
        metrics_updated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS host_protocols (
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(host_id, type)
      );
      CREATE TABLE IF NOT EXISTS protocol_activations (
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(host_id, type)
      );
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        error_json TEXT,
        publisher_admin_id TEXT,
        created_at TEXT NOT NULL,
        published_at TEXT
      );
      CREATE TABLE IF NOT EXISTS node_tasks (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed')),
        result_json TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS node_tasks_host_status_created
      ON node_tasks(host_id, status, created_at);
      CREATE TABLE IF NOT EXISTS host_metric_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        cpu_percent REAL,
        memory_used_bytes INTEGER,
        memory_total_bytes INTEGER,
        network_rx_bytes INTEGER,
        network_tx_bytes INTEGER,
        network_rx_bps REAL,
        network_tx_bps REAL,
        service_status TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS host_metric_samples_host_recorded
      ON host_metric_samples(host_id, recorded_at);
      CREATE INDEX IF NOT EXISTS host_metric_samples_recorded
      ON host_metric_samples(recorded_at);
      CREATE TABLE IF NOT EXISTS usage_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        sample_id TEXT NOT NULL,
        runtime_instance_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE(host_id, sample_id)
      );
      CREATE TABLE IF NOT EXISTS usage_counter_checkpoints (
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        user_name TEXT NOT NULL,
        runtime_instance_id TEXT NOT NULL,
        uplink_bytes INTEGER NOT NULL,
        downlink_bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        baseline_pending INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(host_id, user_name, runtime_instance_id)
      );
      CREATE TABLE IF NOT EXISTS user_usage_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sample_id INTEGER NOT NULL REFERENCES usage_samples(id) ON DELETE CASCADE,
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        uplink_bytes INTEGER NOT NULL,
        downlink_bytes INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS user_usage_ledger_user_recorded
      ON user_usage_ledger(user_id, recorded_at);
      CREATE TABLE IF NOT EXISTS daily_user_usage (
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        usage_date TEXT NOT NULL,
        uplink_bytes INTEGER NOT NULL CHECK (uplink_bytes >= 0),
        downlink_bytes INTEGER NOT NULL CHECK (downlink_bytes >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(host_id, user_id, usage_date)
      );
      CREATE INDEX IF NOT EXISTS daily_user_usage_user_date
      ON daily_user_usage(user_id, usage_date);
    `);
    // Older databases kept only the latest Runtime's watermarks. Keep one
    // checkpoint per instance so delayed samples cannot charge old bytes again.
    // Only reconstruct exact totals if every sample sequence slot survives.
    // Pruning or sequence gaps make summed deltas uncertain; those instances
    // establish a baseline on their next sample instead of charging old bytes.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const checkpointColumns = this.db.prepare("PRAGMA table_info(usage_counter_checkpoints)").all();
      if (!checkpointColumns.find((column) => column.name === "runtime_instance_id")?.pk) {
        this.db.exec(`
          CREATE TABLE usage_counter_checkpoints_migration (
            host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
            user_name TEXT NOT NULL,
            runtime_instance_id TEXT NOT NULL,
            uplink_bytes INTEGER NOT NULL,
            downlink_bytes INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            baseline_pending INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(host_id, user_name, runtime_instance_id)
          );
          INSERT INTO usage_counter_checkpoints_migration (
            host_id, user_name, runtime_instance_id, uplink_bytes, downlink_bytes, updated_at
          ) SELECT host_id, user_name, runtime_instance_id, uplink_bytes, downlink_bytes, updated_at
            FROM usage_counter_checkpoints;
          INSERT INTO usage_counter_checkpoints_migration (
            host_id, user_name, runtime_instance_id, uplink_bytes, downlink_bytes, updated_at, baseline_pending
          )
          SELECT ledger.host_id, users.email, samples.runtime_instance_id,
                 SUM(ledger.uplink_bytes), SUM(ledger.downlink_bytes), MAX(samples.received_at),
                 CASE WHEN (SELECT COUNT(*) FROM usage_samples) =
                   COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'usage_samples'), 0)
                   THEN 0 ELSE 1 END
          FROM user_usage_ledger AS ledger
          JOIN usage_samples AS samples ON samples.id = ledger.sample_id
          JOIN users ON users.id = ledger.user_id
          GROUP BY ledger.host_id, users.email, samples.runtime_instance_id
          ON CONFLICT(host_id, user_name, runtime_instance_id) DO NOTHING;
          DROP TABLE usage_counter_checkpoints;
          ALTER TABLE usage_counter_checkpoints_migration RENAME TO usage_counter_checkpoints;
        `);
        const migratedAt = new Date(this.clock()).toISOString();
        this.db.prepare(`
          INSERT OR IGNORE INTO settings (key, value, updated_at)
          VALUES ('usage_checkpoint_migrated_at', ?, ?)
        `).run(migratedAt, migratedAt);
      }
      if (!this.db.prepare("PRAGMA table_info(usage_counter_checkpoints)").all()
        .some((column) => column.name === "baseline_pending")) {
        this.db.exec("ALTER TABLE usage_counter_checkpoints ADD COLUMN baseline_pending INTEGER NOT NULL DEFAULT 0");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const adminColumns = this.db.prepare("PRAGMA table_info(admins)").all();
    if (!adminColumns.some((column) => column.name === "role")) {
      this.db.exec("ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'");
    }
    const deploymentColumns = this.db.prepare("PRAGMA table_info(deployments)").all();
    if (!deploymentColumns.some((column) => column.name === "publisher_admin_id")) {
      this.db.exec("ALTER TABLE deployments ADD COLUMN publisher_admin_id TEXT");
    }
    const nodeTaskColumns = this.db.prepare("PRAGMA table_info(node_tasks)").all();
    const nodeTaskMigrations = [
      ["priority", "INTEGER NOT NULL DEFAULT 0"],
      ["attempt_count", "INTEGER NOT NULL DEFAULT 0"],
      ["max_attempts", "INTEGER NOT NULL DEFAULT 5"],
      ["next_attempt_at", "TEXT"]
    ];
    for (const [column, definition] of nodeTaskMigrations) {
      if (!nodeTaskColumns.some((candidate) => candidate.name === column)) {
        this.db.exec(`ALTER TABLE node_tasks ADD COLUMN ${column} ${definition}`);
      }
    }
    const userColumns = this.db.prepare("PRAGMA table_info(users)").all();
    if (!userColumns.some((column) => column.name === "used_bytes")) {
      this.db.exec("ALTER TABLE users ADD COLUMN used_bytes INTEGER NOT NULL DEFAULT 0");
      this.db.exec(`
        UPDATE users
        SET used_bytes = CAST(ROUND(used_gb * ${GIBIBYTE}) AS INTEGER)
      `);
    }
    if (!userColumns.some((column) => column.name === "quota_gb")) {
      this.db.exec("ALTER TABLE users ADD COLUMN quota_gb REAL");
    }
    if (!userColumns.some((column) => column.name === "device_limit")) {
      this.db.exec("ALTER TABLE users ADD COLUMN device_limit INTEGER");
    }
    if (!userColumns.some((column) => column.name === "node_scope_json")) {
      this.db.exec("ALTER TABLE users ADD COLUMN node_scope_json TEXT");
    }
    if (!userColumns.some((column) => column.name === "client_formats_json")) {
      this.db.exec("ALTER TABLE users ADD COLUMN client_formats_json TEXT");
    }
    if (!userColumns.some((column) => column.name === "subscription_public_id")) {
      this.db.exec("ALTER TABLE users ADD COLUMN subscription_public_id TEXT");
    }
    if (!userColumns.some((column) => column.name === "subscription_secret_hash")) {
      this.db.exec("ALTER TABLE users ADD COLUMN subscription_secret_hash TEXT");
    }
    if (!userColumns.some((column) => column.name === "subscription_secret_encrypted")) {
      this.db.exec("ALTER TABLE users ADD COLUMN subscription_secret_encrypted TEXT");
    }
    this.db.exec(`
      UPDATE users
      SET subscription_public_id = lower(hex(randomblob(16)))
      WHERE subscription_public_id IS NULL
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_subscription_public_id
      ON users(subscription_public_id)
    `);
    const hostColumns = this.db.prepare("PRAGMA table_info(hosts)").all();
    const hostMigrations = [
      ["endpoint_domain", "TEXT"],
      ["kind", "TEXT NOT NULL DEFAULT 'local'"],
      ["enrollment_secret_hash", "TEXT"],
      ["node_secret_hash", "TEXT"],
      ["hostname", "TEXT"],
      ["platform", "TEXT"],
      ["architecture", "TEXT"],
      ["agent_version", "TEXT"],
      ["runtime_version", "TEXT"],
      ["build_tags_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["applied_protocols_json", "TEXT"],
      ["encryption_public_key", "TEXT"],
      ["usage_last_sample_at", "TEXT"],
      ["usage_last_error", "TEXT"],
      ["usage_last_error_at", "TEXT"],
      ["last_seen_at", "TEXT"],
      ["enrolled_at", "TEXT"],
      ["cpu_percent", "REAL"],
      ["memory_used_bytes", "INTEGER"],
      ["memory_total_bytes", "INTEGER"],
      ["disk_used_bytes", "INTEGER"],
      ["disk_total_bytes", "INTEGER"],
      ["network_rx_bytes", "INTEGER"],
      ["network_tx_bytes", "INTEGER"],
      ["network_rx_bps", "REAL"],
      ["network_tx_bps", "REAL"],
      ["service_status", "TEXT"],
      ["bbr_json", "TEXT"],
      ["metrics_updated_at", "TEXT"]
    ];
    for (const [column, definition] of hostMigrations) {
      if (!hostColumns.some((candidate) => candidate.name === column)) {
        this.db.exec(`ALTER TABLE hosts ADD COLUMN ${column} ${definition}`);
      }
    }
    this.db.exec(`
      UPDATE users
      SET quota_gb = COALESCE(quota_gb, (SELECT quota_gb FROM plans WHERE plans.id = users.plan_id), 120),
          device_limit = COALESCE(device_limit, (SELECT device_limit FROM plans WHERE plans.id = users.plan_id), 3),
          node_scope_json = COALESCE(node_scope_json, (SELECT node_scope_json FROM plans WHERE plans.id = users.plan_id), '["all"]'),
          client_formats_json = COALESCE(client_formats_json, (SELECT client_formats_json FROM plans WHERE plans.id = users.plan_id), '["mihomo","egern","sing-box"]')
    `);
    this.db.prepare(`
      UPDATE users
      SET client_formats_json = '["mihomo","egern","sing-box"]'
      WHERE client_formats_json IS NULL OR client_formats_json <> '["mihomo","egern","sing-box"]'
    `).run();
  }

  seed({ adminUsername, adminPassword, initialHostAddress, initialListenPort, seedDemoData }) {
    const createdAt = nowIso();
    // Bootstrap credentials initialize an empty database only. Reusing them on
    // restart must not recreate an account renamed through account settings.
    const insertAdmin = this.db.prepare(`
      INSERT OR IGNORE INTO admins (id, username, password_hash, role, created_at)
      SELECT ?, ?, ?, 'owner', ?
      WHERE NOT EXISTS (SELECT 1 FROM admins)
    `);
    insertAdmin.run(randomUUID(), adminUsername, hashPassword(adminPassword), createdAt);

    this.db.prepare(`
      INSERT OR IGNORE INTO plans (
        id, name, quota_gb, device_limit, node_scope_json, client_formats_json,
        description, tone, created_at, updated_at
      ) VALUES (?, '用户独立权益兼容记录', 1, 1, '["all"]', '["mihomo","egern","sing-box"]', '仅用于旧数据库外键兼容', 'standard', ?, ?)
    `).run(LEGACY_ENTITLEMENT_PLAN_ID, createdAt, createdAt);

    if (seedDemoData) {
      const insertPlan = this.db.prepare(`
      INSERT OR IGNORE INTO plans (
        id, name, quota_gb, device_limit, node_scope_json, client_formats_json,
        description, tone, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
      for (const plan of seedPlans) {
        insertPlan.run(
          plan.id,
          plan.name,
          plan.quotaGb,
          plan.legacyDeviceLimit,
          JSON.stringify(plan.nodeScope),
          plan.legacyClientFormatsJson,
          plan.description,
          plan.tone,
          createdAt,
          createdAt
        );
      }

      const insertUser = this.db.prepare(`
      INSERT OR IGNORE INTO users (
        id, name, initials, email, password_hash, portal_status, state, used_gb, used_bytes,
        plan_id, quota_gb, device_limit, node_scope_json, client_formats_json,
        expires_at, runtime_uuid, runtime_password, subscription_public_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
      for (const [name, initials, email, portalStatus, state, usedGb, planId, expiresAt] of seedUsers) {
        const entitlement = seedPlans.find((plan) => plan.id === planId);
        insertUser.run(
          randomUUID(),
          name,
          initials,
          email,
          hashPassword("raylink-demo"),
          portalStatus,
          state,
          usedGb,
          Math.round(usedGb * GIBIBYTE),
          planId,
          entitlement.quotaGb,
          entitlement.legacyDeviceLimit,
          JSON.stringify(entitlement.nodeScope),
          entitlement.legacyClientFormatsJson,
          expiresAt,
          randomUUID(),
          createShadowsocksKey(),
          createRuntimePassword(18),
          createdAt,
          createdAt
        );
      }
    }

    this.db.prepare(`
      INSERT OR IGNORE INTO hosts (id, name, address, region, status, created_at, updated_at)
      VALUES ('local', 'RayLink Runtime', ?, 'tokyo', 'unknown', ?, ?)
    `).run(initialHostAddress, createdAt, createdAt);
    this.db.prepare(`
      UPDATE hosts SET name = 'RayLink Runtime', updated_at = ?
      WHERE id = 'local' AND name = 'CycleLink Runtime'
    `).run(createdAt);
    this.db.prepare(`
      INSERT OR IGNORE INTO settings (key, value, updated_at)
      VALUES ('shadowsocks_master_password', ?, ?)
    `).run(createShadowsocksKey(), createdAt);
    this.db.prepare(`
      INSERT OR IGNORE INTO settings (key, value, updated_at)
      VALUES ('runtime_protocols', ?, ?)
    `).run(JSON.stringify(defaultProtocolConfigs(initialListenPort)), createdAt);
    this.db.prepare(`
      INSERT OR IGNORE INTO settings (key, value, updated_at)
      VALUES ('routing_policy', ?, ?)
    `).run(JSON.stringify(DEFAULT_ROUTING_POLICY), createdAt);
    const legacyProtocols = this.db.prepare(
      "SELECT value FROM settings WHERE key = 'runtime_protocols'"
    ).get();
    this.seedHostProtocolConfigs(
      "local",
      normalizeProtocolConfigs(parseJson(legacyProtocols?.value, []))
    );
    this.db.prepare(`
      UPDATE hosts
      SET applied_protocols_json = ?, updated_at = ?
      WHERE id = 'local' AND applied_protocols_json IS NULL
    `).run(
      JSON.stringify(normalizeProtocolConfigs(parseJson(legacyProtocols?.value, []))),
      createdAt
    );
  }

  seedHostProtocolConfigs(hostId, profiles) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO host_protocols (host_id, type, config_json, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    const timestamp = nowIso();
    for (const profile of profiles) {
      insert.run(hostId, profile.type, JSON.stringify(profile), timestamp);
    }
  }

  async authenticateAdmin(username, password) {
    const admin = this.db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
    const valid = await verifyPassword(password, admin?.password_hash || DUMMY_PASSWORD_HASH);
    if (!admin || !valid) return null;
    // Password verification yields to the event loop; a concurrent rotation may
    // have revoked this identity while scrypt was running.
    const current = this.db.prepare("SELECT * FROM admins WHERE id = ?").get(admin.id);
    if (!current || current.password_hash !== admin.password_hash || current.username !== admin.username) return null;
    return { id: current.id, username: current.username, role: current.role || "owner" };
  }

  revokeAdminCredentials(id, { revokeMcp = false } = {}) {
    const sessionsRevoked = Number(this.db.prepare("DELETE FROM sessions WHERE admin_id = ?").run(id).changes);
    let mcpTokensRevoked = 0;
    if (revokeMcp && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_credentials'").get()) {
      mcpTokensRevoked = Number(this.db.prepare(`
        UPDATE mcp_credentials SET revoked_at = ? WHERE admin_id = ? AND revoked_at IS NULL
      `).run(nowIso(), id).changes);
    }
    return { sessionsRevoked, mcpTokensRevoked };
  }

  async changeAdminAccount(id, input = {}, { changePassword = false } = {}) {
    const { currentPassword } = input || {};
    const value = changePassword ? validateAdminPassword(input?.newPassword) : validateAdminUsername(input?.username);
    const snapshot = this.db.prepare("SELECT username, password_hash FROM admins WHERE id = ?").get(id);
    if (typeof currentPassword !== "string" || currentPassword.length > 4096
      || !await verifyPassword(currentPassword, snapshot?.password_hash || DUMMY_PASSWORD_HASH) || !snapshot) {
      throw domainError("CURRENT_PASSWORD_INVALID", "当前密码不正确", 403);
    }
    if (changePassword && currentPassword === value) throw domainError("PASSWORD_UNCHANGED", "新密码不能与当前密码相同");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT username, password_hash FROM admins WHERE id = ?").get(id);
      if (!current || current.password_hash !== snapshot.password_hash || current.username !== snapshot.username) {
        throw domainError("ACCOUNT_CHANGED", "账号已变更，请重新登录后重试", 409);
      }
      if (changePassword) {
        this.db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(hashPassword(value), id);
      } else {
        this.db.prepare("UPDATE admins SET username = ? WHERE id = ?").run(value, id);
      }
      const revoked = this.revokeAdminCredentials(id, { revokeMcp: changePassword });
      this.db.exec("COMMIT");
      return {
        ...(changePassword ? { passwordChanged: true } : { profileUpdated: true, username: value }),
        reauthenticationRequired: true,
        ...revoked
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (/UNIQUE constraint failed: admins\.username/i.test(error.message)) {
        throw domainError("ADMIN_USERNAME_EXISTS", "管理员用户名已经存在", 409);
      }
      throw error;
    }
  }

  listAdmins() {
    return this.db.prepare(`
      SELECT id, username, role, created_at
      FROM admins
      ORDER BY created_at, username
    `).all().map((admin) => ({
      id: admin.id,
      username: admin.username,
      role: admin.role || "owner",
      createdAt: admin.created_at
    }));
  }

  createAdmin(input) {
    const admin = {
      id: randomUUID(),
      username: validateAdminUsername(input.username),
      role: validateAdminRole(input.role),
      password: validateAdminPassword(input.password),
      createdAt: nowIso()
    };
    try {
      this.db.prepare(`
        INSERT INTO admins (id, username, password_hash, role, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        admin.id,
        admin.username,
        hashPassword(admin.password),
        admin.role,
        admin.createdAt
      );
    } catch (error) {
      if (/UNIQUE constraint failed: admins\.username/i.test(error.message)) {
        throw domainError("ADMIN_USERNAME_EXISTS", "管理员用户名已经存在", 409);
      }
      throw error;
    }
    return {
      id: admin.id,
      username: admin.username,
      role: admin.role,
      createdAt: admin.createdAt
    };
  }

  updateAdmin(id, input) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare(
        "SELECT id, username, role, created_at FROM admins WHERE id = ?"
      ).get(id);
      if (!current) throw domainError("ADMIN_NOT_FOUND", "管理员不存在", 404);
      const username = input.username === undefined
        ? current.username
        : validateAdminUsername(input.username);
      const role = input.role === undefined
        ? current.role
        : validateAdminRole(input.role);
      if (current.role === "owner" && role !== "owner") {
        const owners = this.db.prepare(
          "SELECT COUNT(*) AS count FROM admins WHERE role = 'owner'"
        ).get().count;
        if (Number(owners) <= 1) {
          throw domainError("LAST_OWNER_REQUIRED", "系统必须保留至少一个 Owner", 409);
        }
      }
      const password = input.password === undefined
        ? null
        : validateAdminPassword(input.password);
      try {
        this.db.prepare(`
          UPDATE admins
          SET username = ?, role = ?,
              password_hash = CASE WHEN ? IS NULL THEN password_hash ELSE ? END
          WHERE id = ?
        `).run(
          username,
          role,
          password,
          password ? hashPassword(password) : null,
          id
        );
      } catch (error) {
        if (/UNIQUE constraint failed: admins\.username/i.test(error.message)) {
          throw domainError("ADMIN_USERNAME_EXISTS", "管理员用户名已经存在", 409);
        }
        throw error;
      }
      if (password || username !== current.username) {
        this.revokeAdminCredentials(id, { revokeMcp: Boolean(password) });
      }
      this.db.exec("COMMIT");
      return {
        id,
        username,
        role,
        createdAt: current.created_at
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordAuditEvent({
    adminId,
    actorUsername,
    actorRole,
    action,
    resourceType,
    resourceId = null,
    metadata = {}
  }) {
    this.db.prepare(`
      INSERT INTO audit_events (
        admin_id, actor_username, actor_role, action, resource_type,
        resource_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      adminId || null,
      String(actorUsername || "unknown"),
      String(actorRole || "unknown"),
      String(action || "unknown"),
      String(resourceType || "system"),
      resourceId ? String(resourceId) : null,
      JSON.stringify(metadata),
      nowIso()
    );
  }

  listAuditEvents(limit = 100) {
    const boundedLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.db.prepare(`
      SELECT id, admin_id, actor_username, actor_role, action, resource_type,
             resource_id, metadata_json, created_at
      FROM audit_events
      ORDER BY id DESC
      LIMIT ?
    `).all(boundedLimit).map((event) => ({
      id: event.id,
      adminId: event.admin_id,
      actorUsername: event.actor_username,
      actorRole: event.actor_role,
      action: event.action,
      resourceType: event.resource_type,
      resourceId: event.resource_id,
      metadata: parseJson(event.metadata_json, {}),
      createdAt: event.created_at
    }));
  }

  initializeSetup({ setupRequired, setupTokenHash, setupTokenExpiresAt }) {
    if (Boolean(setupTokenHash) !== Boolean(setupTokenExpiresAt)) {
      throw domainError(
        "SETUP_TOKEN_INCOMPLETE",
        "初始化令牌哈希与有效期必须同时配置",
        500
      );
    }
    const existing = this.db.prepare(
      "SELECT value FROM settings WHERE key = 'setup_state'"
    ).get();
    if (existing) {
      if (existing.value === "INITIALIZING") {
        try {
          this.db.exec("BEGIN IMMEDIATE");
          this.db.prepare(`
            UPDATE settings SET value = 'SETUP_PENDING', updated_at = ?
            WHERE key = 'setup_state'
          `).run(nowIso());
          this.db.prepare("DELETE FROM settings WHERE key = 'setup_progress'").run();
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
        existing.value = "SETUP_PENDING";
      }
      if (
        ["UNINITIALIZED", "SETUP_PENDING"].includes(existing.value)
        && setupRequired
        && setupTokenHash
      ) {
        const timestamp = nowIso();
        const upsert = this.db.prepare(`
          INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `);
        upsert.run("setup_token_hash", setupTokenHash, timestamp);
        upsert.run("setup_token_expires_at", setupTokenExpiresAt, timestamp);
        upsert.run("setup_state", "SETUP_PENDING", timestamp);
      }
      return;
    }

    const timestamp = nowIso();
    const state = setupRequired
      ? setupTokenHash
        ? "SETUP_PENDING"
        : "UNINITIALIZED"
      : "READY";
    const insert = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    `);
    insert.run("setup_state", state, timestamp);
    if (setupRequired && setupTokenHash) {
      insert.run("setup_token_hash", setupTokenHash, timestamp);
      insert.run("setup_token_expires_at", setupTokenExpiresAt, timestamp);
    }
  }

  setupStatus() {
    const rows = this.db.prepare(`
      SELECT key, value FROM settings
      WHERE key IN (
        'setup_state', 'setup_token_expires_at', 'canonical_origin', 'subscription_origin',
        'allowed_origins', 'access_mode', 'certificate_mode', 'setup_progress'
      )
    `).all();
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const state = settings.setup_state || "READY";
    return {
      state,
      ...(state === "SETUP_PENDING"
        ? { expiresAt: settings.setup_token_expires_at || null }
        : {}),
      ...(state === "INITIALIZING" && settings.setup_progress
        ? { progress: parseJson(settings.setup_progress, null) }
        : {}),
      access: settings.canonical_origin
        ? {
            mode: settings.access_mode,
            canonicalOrigin: settings.canonical_origin,
            subscriptionOrigin: settings.subscription_origin || settings.canonical_origin,
            allowedOrigins: parseJson(settings.allowed_origins, []),
            certificateMode: settings.certificate_mode
          }
        : null
    };
  }

  certificateSettings() {
    const rows = this.db.prepare(`
      SELECT key, value FROM settings
      WHERE key IN ('certificate_mode', 'certificate_email')
    `).all();
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      mode: settings.certificate_mode || null,
      email: settings.certificate_email || ""
    };
  }

  updateCertificateSettings(input = {}) {
    const email = normalizeCertificateEmail(input.email);
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('certificate_email', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(email, timestamp);
    return this.certificateSettings();
  }

  routingPolicy() {
    const row = this.db.prepare(
      "SELECT value FROM settings WHERE key = 'routing_policy'"
    ).get();
    return normalizeRoutingPolicy(parseJson(row?.value, DEFAULT_ROUTING_POLICY));
  }

  updateRoutingPolicy(input = {}) {
    const policy = normalizeRoutingPolicy(input);
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ('routing_policy', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(policy), nowIso());
    return policy;
  }

  verifySetupToken(token) {
    const status = this.setupStatus();
    if (status.state !== "SETUP_PENDING") return false;
    if (!status.expiresAt || Date.parse(status.expiresAt) <= Date.now()) return false;
    const stored = this.db.prepare(
      "SELECT value FROM settings WHERE key = 'setup_token_hash'"
    ).get()?.value;
    if (!stored) return false;
    const actual = Buffer.from(hashSessionSecret(String(token || "")));
    const expected = Buffer.from(stored);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  beginSetupInitialization() {
    const timestamp = nowIso();
    const progress = {
      stage: "starting",
      current: 0,
      total: 4,
      message: "正在准备初始化",
      updatedAt: timestamp
    };
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const result = this.db.prepare(`
        UPDATE settings SET value = 'INITIALIZING', updated_at = ?
        WHERE key = 'setup_state' AND value = 'SETUP_PENDING'
      `).run(timestamp);
      if (result.changes !== 1) {
        throw domainError("SETUP_IN_PROGRESS", "RayLink 正在初始化或已经完成", 409);
      }
      this.db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('setup_progress', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(JSON.stringify(progress), timestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return progress;
  }

  updateSetupProgress({ stage, current, total, message }) {
    if (this.setupStatus().state !== "INITIALIZING") {
      throw domainError("SETUP_NOT_INITIALIZING", "初始化当前未在执行", 409);
    }
    const timestamp = nowIso();
    const progress = {
      stage: String(stage || "starting"),
      current: Math.max(0, Number.parseInt(current, 10) || 0),
      total: Math.max(1, Number.parseInt(total, 10) || 4),
      message: String(message || "正在初始化"),
      updatedAt: timestamp
    };
    progress.current = Math.min(progress.current, progress.total);
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES ('setup_progress', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(progress), timestamp);
    return progress;
  }

  failSetupInitialization() {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.prepare(`
        UPDATE settings SET value = 'SETUP_PENDING', updated_at = ?
        WHERE key = 'setup_state' AND value = 'INITIALIZING'
      `).run(nowIso());
      this.db.prepare("DELETE FROM settings WHERE key = 'setup_progress'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeSetup({ access, certificate, admin, runtime }) {
    if (this.setupStatus().state !== "INITIALIZING") {
      throw domainError("SETUP_ALREADY_COMPLETE", "RayLink 已完成初始化", 409);
    }
    const currentAdmin = this.db.prepare(
      "SELECT id FROM admins ORDER BY created_at LIMIT 1"
    ).get();
    if (!currentAdmin) {
      throw domainError("ADMIN_NOT_FOUND", "初始化管理员不存在", 500);
    }

    const timestamp = nowIso();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.prepare(`
        UPDATE admins SET username = ?, password_hash = ? WHERE id = ?
      `).run(admin.username, hashPassword(admin.password), currentAdmin.id);
      this.db.prepare("DELETE FROM sessions").run();

      const upsert = this.db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `);
      upsert.run("setup_state", "READY", timestamp);
      upsert.run("canonical_origin", access.canonicalOrigin, timestamp);
      upsert.run("subscription_origin", access.subscriptionOrigin, timestamp);
      upsert.run("allowed_origins", JSON.stringify(access.allowedOrigins), timestamp);
      upsert.run("access_mode", access.mode, timestamp);
      upsert.run("certificate_mode", certificate.mode, timestamp);
      upsert.run("certificate_email", certificate.email || "", timestamp);
      this.db.prepare(
        "DELETE FROM settings WHERE key IN ('setup_token_hash', 'setup_token_expires_at', 'setup_progress')"
      ).run();

      this.db.prepare(`
        UPDATE hosts SET name = ?, address = ?, region = ?, updated_at = ?
        WHERE id = 'local'
      `).run(runtime.name, runtime.address, runtime.region, timestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { id: currentAdmin.id, username: admin.username, role: "owner" };
  }

  createAdminSession(adminId, ttlSeconds = 43_200) {
    const secret = createSessionSecret();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO sessions (secret_hash, admin_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(hashSessionSecret(secret), adminId, expiresAt, nowIso());
    return { secret, expiresAt };
  }

  adminForSession(secret) {
    if (!secret) return null;
    return this.db.prepare(`
      SELECT admins.id, admins.username, admins.role
      FROM sessions
      JOIN admins ON admins.id = sessions.admin_id
      WHERE sessions.secret_hash = ? AND sessions.expires_at > ?
    `).get(hashSessionSecret(secret), nowIso()) || null;
  }

  revokeAdminSession(secret) {
    if (!secret) return false;
    const result = this.db.prepare(
      "DELETE FROM sessions WHERE secret_hash = ?"
    ).run(hashSessionSecret(secret));
    return result.changes > 0;
  }

  performOperationalMaintenance({
    now = nowIso(),
    deploymentHistoryLimit = 50,
    nodeTaskHistoryLimit = 50,
    usageDetailRetentionDays = 30,
    dailyUsageRetentionDays = 400
  } = {}) {
    const boundedDeploymentLimit = Math.min(
      1_000,
      Math.max(20, Number(deploymentHistoryLimit) || 50)
    );
    const boundedNodeTaskLimit = Math.min(
      1_000,
      Math.max(20, Number(nodeTaskHistoryLimit) || 50)
    );
    const boundedUsageRetentionDays = Math.min(
      365,
      Math.max(7, Number(usageDetailRetentionDays) || 30)
    );
    const boundedDailyUsageRetentionDays = Math.min(
      3_650,
      Math.max(30, Number(dailyUsageRetentionDays) || 400)
    );
    const maintenanceTime = new Date(now);
    if (!Number.isFinite(maintenanceTime.getTime())) {
      throw domainError("INVALID_MAINTENANCE_TIME", "维护时间无效");
    }
    const usageDetailCutoff = new Date(
      maintenanceTime.getTime() - boundedUsageRetentionDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const dailyUsageCutoff = new Date(
      maintenanceTime.getTime() - boundedDailyUsageRetentionDays * 24 * 60 * 60 * 1000
    ).toISOString().slice(0, 10);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const administratorSessions = this.db.prepare(
        "DELETE FROM sessions WHERE expires_at <= ?"
      ).run(now);
      const userSessions = this.db.prepare(
        "DELETE FROM user_sessions WHERE expires_at <= ?"
      ).run(now);
      const deployments = this.db.prepare(`
        DELETE FROM deployments
        WHERE status <> 'active'
          AND id IN (
            SELECT id
            FROM (
              SELECT id,
                     ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS history_rank
              FROM deployments
              WHERE status <> 'active'
            )
            WHERE history_rank > ?
          )
      `).run(boundedDeploymentLimit);
      const nodeTasks = this.db.prepare(`
        DELETE FROM node_tasks
        WHERE id IN (
          SELECT id
          FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY host_id, kind
                     ORDER BY finished_at DESC, created_at DESC, id DESC
                   ) AS history_rank
            FROM node_tasks
            WHERE status IN ('succeeded', 'failed')
          )
          WHERE history_rank > ?
        )
      `).run(boundedNodeTaskLimit);
      const usageSamples = this.db.prepare(`
        DELETE FROM usage_samples
        WHERE received_at < ?
      `).run(usageDetailCutoff);
      const dailyUsage = this.db.prepare(`
        DELETE FROM daily_user_usage
        WHERE usage_date < ?
      `).run(dailyUsageCutoff);
      this.db.exec("COMMIT");
      return {
        sessions: {
          administrator: Number(administratorSessions.changes),
          user: Number(userSessions.changes)
        },
        history: {
          deployments: Number(deployments.changes),
          nodeTasks: Number(nodeTasks.changes),
          usageSamples: Number(usageSamples.changes),
          usageDetailRetentionDays: boundedUsageRetentionDays,
          dailyUsage: Number(dailyUsage.changes),
          dailyUsageRetentionDays: boundedDailyUsageRetentionDays
        }
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async authenticateUser(email, password) {
    const user = this.db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim().toLowerCase());
    const valid = await verifyPassword(password, user?.password_hash || DUMMY_PASSWORD_HASH);
    if (!user || !valid) return null;
    return {
      id: user.id,
      email: user.email,
      portalStatus: user.portal_status
    };
  }

  createUserSession(userId, ttlSeconds = 43_200) {
    const secret = createSessionSecret();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO user_sessions (secret_hash, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(hashSessionSecret(secret), userId, expiresAt, nowIso());
    return { secret, expiresAt };
  }

  userForSession(secret) {
    if (!secret) return null;
    return this.db.prepare(`
      SELECT users.id
      FROM user_sessions
      JOIN users ON users.id = user_sessions.user_id
      WHERE user_sessions.secret_hash = ? AND user_sessions.expires_at > ?
    `).get(hashSessionSecret(secret), nowIso()) || null;
  }

  portalProfile(userId) {
    const row = this.db.prepare(`
      SELECT users.id, users.name, users.initials, users.email, users.portal_status,
             users.state, users.used_gb, users.quota_gb,
             users.node_scope_json, users.expires_at,
             users.subscription_public_id, users.subscription_secret_hash,
             users.subscription_secret_encrypted
      FROM users
      WHERE users.id = ?
    `).get(userId);
    if (!row) return null;
    return {
      user: userFromRow(row),
      entitlement: {
        quotaGb: row.quota_gb,
        nodeScope: parseJson(row.node_scope_json, [])
      }
    };
  }

  clientCredential(userId) {
    const row = this.db.prepare(`
      SELECT users.email, users.runtime_uuid, users.runtime_password, users.state, users.portal_status,
             users.expires_at, users.used_gb, users.quota_gb, users.node_scope_json,
             (SELECT region FROM hosts WHERE id = 'local') AS host_region,
             (SELECT value FROM settings WHERE key = 'shadowsocks_master_password') AS server_password
      FROM users
      WHERE users.id = ?
    `).get(userId);
    if (!row) return null;
    return {
      email: row.email,
      runtimeUuid: row.runtime_uuid,
      runtimePassword: row.runtime_password,
      serverPassword: row.server_password,
      state: row.state,
      portalStatus: row.portal_status,
      expiresAt: row.expires_at,
      usedGb: row.used_gb,
      quotaGb: row.quota_gb,
      nodeScope: parseJson(row.node_scope_json, []),
      hostRegion: row.host_region
    };
  }

  rotateUserSubscription(userId) {
    const user = this.db.prepare(`
      SELECT id, subscription_public_id
      FROM users
      WHERE id = ?
    `).get(userId);
    if (!user) throw domainError("USER_NOT_FOUND", "用户不存在", 404);
    const publicId = user.subscription_public_id || createRuntimePassword(18);
    const secret = createSessionSecret();
    const encryptedSecret = protectSubscriptionSecret(
      secret,
      this.subscriptionEncryptionKey,
      publicId
    );
    this.db.prepare(`
      UPDATE users
      SET subscription_public_id = ?, subscription_secret_hash = ?,
          subscription_secret_encrypted = ?, updated_at = ?
      WHERE id = ?
    `).run(
      publicId,
      hashSessionSecret(secret),
      encryptedSecret,
      nowIso(),
      userId
    );
    return { publicId, secret };
  }

  currentUserSubscription(userId) {
    const user = this.db.prepare(`
      SELECT subscription_public_id, subscription_secret_hash,
             subscription_secret_encrypted
      FROM users
      WHERE id = ?
    `).get(userId);
    if (!user) throw domainError("USER_NOT_FOUND", "用户不存在", 404);
    if (!user.subscription_secret_hash) {
      return { configured: false, recoverable: false };
    }
    if (!user.subscription_secret_encrypted) {
      return {
        configured: true,
        recoverable: false,
        publicId: user.subscription_public_id
      };
    }
    try {
      const secret = revealSubscriptionSecret(
        user.subscription_secret_encrypted,
        this.subscriptionEncryptionKey,
        user.subscription_public_id
      );
      if (hashSessionSecret(secret) !== user.subscription_secret_hash) {
        throw new Error("订阅凭据校验失败");
      }
      return {
        configured: true,
        recoverable: true,
        publicId: user.subscription_public_id,
        secret
      };
    } catch {
      return {
        configured: true,
        recoverable: false,
        publicId: user.subscription_public_id,
        reason: "decryption-failed"
      };
    }
  }

  userForSubscription(publicId, secret) {
    if (!publicId || !secret) return null;
    const user = this.db.prepare(`
      SELECT id, used_bytes, quota_gb, expires_at
      FROM users
      WHERE subscription_public_id = ?
        AND subscription_secret_hash = ?
    `).get(publicId, hashSessionSecret(secret));
    if (!user) return null;
    return {
      id: user.id,
      usedBytes: Number(user.used_bytes || 0),
      quotaGb: Number(user.quota_gb),
      expiresAt: user.expires_at
    };
  }

  listUsers() {
    return this.db.prepare(`
      SELECT id, name, initials, email, portal_status, state, used_gb, used_bytes, quota_gb,
             node_scope_json, expires_at,
             subscription_public_id, subscription_secret_hash,
             subscription_secret_encrypted
      FROM users
      ORDER BY created_at, name
    `).all().map(userFromRow);
  }

  listHosts() {
    return this.db.prepare(`
      SELECT hosts.*,
             SUM(CASE
               WHEN node_tasks.kind = 'publish-config'
                 AND node_tasks.status IN ('pending', 'claimed')
               THEN 1 ELSE 0
             END)
               AS pending_task_count,
             MAX(CASE
               WHEN node_tasks.kind = 'publish-config'
                 AND node_tasks.status IN ('pending', 'claimed')
                 AND node_tasks.priority >= 100
               THEN 1 ELSE 0
             END) AS critical_pending,
             SUM(CASE
               WHEN node_tasks.kind = 'upgrade-runtime'
                 AND node_tasks.status IN ('pending', 'claimed')
               THEN 1 ELSE 0
             END) AS pending_upgrade_count,
             (
               SELECT status FROM node_tasks AS latest_upgrade
               WHERE latest_upgrade.host_id = hosts.id
                 AND latest_upgrade.kind = 'upgrade-runtime'
               ORDER BY latest_upgrade.created_at DESC LIMIT 1
             ) AS latest_upgrade_status,
             (
               SELECT payload_json FROM node_tasks AS latest_upgrade
               WHERE latest_upgrade.host_id = hosts.id
                 AND latest_upgrade.kind = 'upgrade-runtime'
               ORDER BY latest_upgrade.created_at DESC LIMIT 1
             ) AS latest_upgrade_payload_json,
             (
               SELECT result_json FROM node_tasks AS latest_upgrade
               WHERE latest_upgrade.host_id = hosts.id
                 AND latest_upgrade.kind = 'upgrade-runtime'
               ORDER BY latest_upgrade.created_at DESC LIMIT 1
             ) AS latest_upgrade_result_json,
             (
               SELECT finished_at FROM node_tasks AS latest_upgrade
               WHERE latest_upgrade.host_id = hosts.id
                 AND latest_upgrade.kind = 'upgrade-runtime'
               ORDER BY latest_upgrade.created_at DESC LIMIT 1
             ) AS latest_upgrade_finished_at
      FROM hosts
      LEFT JOIN node_tasks ON node_tasks.host_id = hosts.id
      GROUP BY hosts.id
      ORDER BY hosts.created_at
    `).all().map((row) => {
      const host = hostFromRow(row);
      return {
        ...host,
        nodeUpgrade: this.hostTaskStatus(host.id, "upgrade-node"),
        bbrTask: this.hostTaskStatus(host.id, "configure-bbr"),
        protocols: this.listHostProtocolConfigs(host.id),
        protocolActivations: this.listProtocolActivations(host.id)
      };
    });
  }

  recordUsageSnapshot(hostId, input = {}) {
    const host = this.getHost(hostId);
    if (!host) throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    const sampleId = String(input.sampleId || "");
    const runtimeInstanceId = String(input.runtimeInstanceId || "");
    if (!/^[a-zA-Z0-9_.:-]{8,160}$/.test(sampleId)) {
      throw domainError("INVALID_USAGE_SAMPLE", "流量样本编号无效");
    }
    if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(runtimeInstanceId)) {
      throw domainError("INVALID_RUNTIME_INSTANCE", "Runtime 实例编号无效");
    }
    if (!Array.isArray(input.users) || input.users.length > 10_000) {
      throw domainError("INVALID_USAGE_SAMPLE", "流量样本用户列表无效");
    }
    const receivedAtDate = new Date(this.clock());
    if (!Number.isFinite(receivedAtDate.getTime())) {
      throw domainError("INVALID_USAGE_CLOCK", "控制面计量时间无效", 500);
    }
    const observedAt = new Date(input.observedAt || receivedAtDate);
    if (!Number.isFinite(observedAt.getTime())) {
      throw domainError("INVALID_USAGE_SAMPLE", "流量样本时间无效");
    }
    const sampleAgeMs = receivedAtDate.getTime() - observedAt.getTime();
    if (sampleAgeMs > MAX_USAGE_SAMPLE_AGE_MS) {
      throw domainError("STALE_USAGE_SAMPLE", "流量样本超过 7 天接收窗口，已拒绝");
    }
    if (sampleAgeMs < -MAX_USAGE_SAMPLE_FUTURE_SKEW_MS) {
      throw domainError("FUTURE_USAGE_SAMPLE", "流量样本时间超前超过 5 分钟，已拒绝");
    }
    const normalized = input.users.map((usage) => {
      const userName = String(usage.name || "").trim();
      const uplinkBytes = Number(usage.uplinkBytes);
      const downlinkBytes = Number(usage.downlinkBytes);
      if (
        !userName
        || userName.length > 320
        || !Number.isSafeInteger(uplinkBytes)
        || !Number.isSafeInteger(downlinkBytes)
        || uplinkBytes < 0
        || downlinkBytes < 0
      ) {
        throw domainError("INVALID_USAGE_COUNTER", "用户流量计数器无效");
      }
      return { userName, uplinkBytes, downlinkBytes };
    });
    const receivedAt = receivedAtDate.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO usage_samples (
          host_id, sample_id, runtime_instance_id, observed_at, received_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(hostId, sampleId, runtimeInstanceId, observedAt.toISOString(), receivedAt);
      this.db.prepare(`
        UPDATE hosts
        SET usage_last_sample_at = ?, usage_last_error = NULL,
            usage_last_error_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(receivedAt, receivedAt, hostId);
      if (Number(inserted.changes) === 0) {
        this.db.exec("COMMIT");
        return { applied: false, duplicate: true, appliedBytes: 0, quotaExceededUserIds: [] };
      }
      const usageSampleId = Number(inserted.lastInsertRowid);
      const migrationTime = this.db.prepare(
        "SELECT value FROM settings WHERE key = 'usage_checkpoint_migrated_at'"
      ).get()?.value;
      let appliedBytes = 0;
      const quotaExceededUserIds = [];
      for (const usage of normalized) {
        const user = this.db.prepare(`
          SELECT id, used_bytes, quota_gb
          FROM users
          WHERE email = ?
        `).get(usage.userName);
        if (!user) continue;
        const checkpoint = this.db.prepare(`
          SELECT runtime_instance_id, uplink_bytes, downlink_bytes, baseline_pending
          FROM usage_counter_checkpoints
          WHERE host_id = ? AND user_name = ? AND runtime_instance_id = ?
        `).get(hostId, usage.userName, runtimeInstanceId);
        const sameRuntime = checkpoint?.runtime_instance_id === runtimeInstanceId;
        // A pre-upgrade delayed counter with no surviving watermark/ledger
        // cannot safely be treated as wholly new usage. Establish a baseline;
        // future increments (and genuinely new post-upgrade instances) bill normally.
        const baselineOnly = Boolean(checkpoint?.baseline_pending)
          || (!checkpoint && migrationTime && observedAt.getTime() <= Date.parse(migrationTime));
        const previousUplink = Number(checkpoint?.uplink_bytes || 0);
        const previousDownlink = Number(checkpoint?.downlink_bytes || 0);
        const uplinkDelta = baselineOnly ? 0 : sameRuntime
          ? Math.max(0, usage.uplinkBytes - previousUplink)
          : usage.uplinkBytes;
        const downlinkDelta = baselineOnly ? 0 : sameRuntime
          ? Math.max(0, usage.downlinkBytes - previousDownlink)
          : usage.downlinkBytes;
        const checkpointUplink = sameRuntime && !baselineOnly
          ? Math.max(previousUplink, usage.uplinkBytes)
          : usage.uplinkBytes;
        const checkpointDownlink = sameRuntime && !baselineOnly
          ? Math.max(previousDownlink, usage.downlinkBytes)
          : usage.downlinkBytes;
        this.db.prepare(`
          INSERT INTO usage_counter_checkpoints (
            host_id, user_name, runtime_instance_id, uplink_bytes, downlink_bytes, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(host_id, user_name, runtime_instance_id) DO UPDATE SET
            runtime_instance_id = excluded.runtime_instance_id,
            baseline_pending = 0,
            uplink_bytes = excluded.uplink_bytes,
            downlink_bytes = excluded.downlink_bytes,
            updated_at = excluded.updated_at
        `).run(
          hostId,
          usage.userName,
          runtimeInstanceId,
          checkpointUplink,
          checkpointDownlink,
          receivedAt
        );
        const delta = uplinkDelta + downlinkDelta;
        if (delta === 0) continue;
        this.db.prepare(`
          INSERT INTO user_usage_ledger (
            sample_id, host_id, user_id, uplink_bytes, downlink_bytes, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          usageSampleId,
          hostId,
          user.id,
          uplinkDelta,
          downlinkDelta,
          observedAt.toISOString()
        );
        this.db.prepare(`
          INSERT INTO daily_user_usage (
            host_id, user_id, usage_date, uplink_bytes, downlink_bytes, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(host_id, user_id, usage_date) DO UPDATE SET
            uplink_bytes = daily_user_usage.uplink_bytes + excluded.uplink_bytes,
            downlink_bytes = daily_user_usage.downlink_bytes + excluded.downlink_bytes,
            updated_at = excluded.updated_at
        `).run(
          hostId,
          user.id,
          observedAt.toISOString().slice(0, 10),
          uplinkDelta,
          downlinkDelta,
          receivedAt
        );
        const beforeBytes = Number(user.used_bytes || 0);
        const afterBytes = beforeBytes + delta;
        if (!Number.isSafeInteger(afterBytes)) {
          throw domainError("USAGE_COUNTER_OVERFLOW", "用户累计流量超过安全计量范围");
        }
        this.db.prepare(`
          UPDATE users
          SET used_bytes = ?, used_gb = ?, updated_at = ?
          WHERE id = ?
        `).run(afterBytes, afterBytes / GIBIBYTE, receivedAt, user.id);
        const quotaBytes = Number(user.quota_gb) * GIBIBYTE;
        if (beforeBytes < quotaBytes && afterBytes >= quotaBytes) {
          quotaExceededUserIds.push(user.id);
        }
        appliedBytes += delta;
      }
      this.db.exec("COMMIT");
      return {
        applied: true,
        duplicate: false,
        appliedBytes,
        quotaExceededUserIds
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordUsageMeteringError(hostId, message) {
    const host = this.getHost(hostId);
    if (!host) throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    const timestamp = nowIso();
    const safeMessage = String(message || "未知计量错误")
      .replace(/[\r\n\t]+/g, " ")
      .slice(0, 500);
    this.db.prepare(`
      UPDATE hosts
      SET usage_last_error = ?, usage_last_error_at = ?, updated_at = ?
      WHERE id = ?
    `).run(safeMessage, timestamp, timestamp, hostId);
    return this.getHost(hostId).usageMetering;
  }

  listClientHosts() {
    return this.db.prepare(`
      SELECT hosts.*
      FROM hosts
      WHERE hosts.id = 'local'
         OR EXISTS (
           SELECT 1 FROM node_tasks
           WHERE node_tasks.host_id = hosts.id
             AND node_tasks.kind = 'publish-config'
             AND node_tasks.status = 'succeeded'
         )
      ORDER BY hosts.created_at
    `).all().map((row) => {
      const host = hostFromRow(row);
      return {
        ...host,
        protocols: this.listHostProtocolConfigs(host.id),
        protocolActivations: this.listProtocolActivations(host.id)
      };
    });
  }

  markHostProtocolsApplied(hostId, profiles = this.listHostProtocolConfigs(hostId)) {
    const normalized = normalizeProtocolConfigs(profiles);
    const result = this.db.prepare(`
      UPDATE hosts
      SET applied_protocols_json = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(normalized), nowIso(), hostId);
    if (Number(result.changes) === 0) {
      throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    }
    return normalized;
  }

  getHost(id) {
    const row = this.db.prepare("SELECT * FROM hosts WHERE id = ?").get(id);
    if (!row) return null;
    const host = hostFromRow(row);
    return {
      ...host,
      nodeUpgrade: this.hostTaskStatus(id, "upgrade-node"),
      bbrTask: this.hostTaskStatus(id, "configure-bbr"),
      protocols: this.listHostProtocolConfigs(id),
      protocolActivations: this.listProtocolActivations(id)
    };
  }

  hostTaskStatus(hostId, kind) {
    const row = this.db.prepare("SELECT * FROM node_tasks WHERE host_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(hostId, kind);
    const payload = parseJson(row?.payload_json, {});
    const envelope = parseJson(row?.result_json, {});
    const result = envelope?.result || {};
    return { pending: ["pending", "claimed"].includes(row?.status), status: row?.status || "never",
      targetVersion: payload.targetVersion || null, agentVersion: result.agentVersion || null,
      error: result.error || null, finishedAt: row?.finished_at || null };
  }

  nodeEncryptionPublicKey(hostId) {
    return this.db.prepare(`
      SELECT encryption_public_key
      FROM hosts
      WHERE id = ? AND kind = 'remote'
    `).get(hostId)?.encryption_public_key || null;
  }

  setHostEndpointDomain(hostId, domain) {
    const current = this.getHost(hostId);
    if (!current) throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    if (typeof domain !== "string" || isIP(domain) || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) {
      throw domainError("INVALID_HOST_ADDRESS", "请输入有效的节点业务域名");
    }
    domain = domain.toLowerCase();
    this.db.exec("SAVEPOINT host_endpoint_domain");
    try {
      this.db.prepare("UPDATE hosts SET endpoint_domain=?, updated_at=? WHERE id=?").run(domain, nowIso(), hostId);
      if (current.endpointDomain !== domain) {
        this.db.prepare("UPDATE protocol_activations SET state_json=json_remove(state_json, '$.publicCheck'), updated_at=? WHERE host_id=?").run(nowIso(), hostId);
      }
      this.db.exec("RELEASE host_endpoint_domain");
    } catch (error) {
      this.db.exec("ROLLBACK TO host_endpoint_domain; RELEASE host_endpoint_domain");
      throw error;
    }
    return this.getHost(hostId);
  }

  createRemoteHost(input) {
    const host = normalizedHostInput(input);
    const id = randomUUID();
    const enrollmentToken = createSessionSecret();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO hosts (
        id, name, address, region, status, kind, enrollment_secret_hash,
        build_tags_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 'remote', ?, '[]', ?, ?)
    `).run(
      id,
      host.name,
      host.address,
      host.region,
      hashSessionSecret(enrollmentToken),
      timestamp,
      timestamp
    );
    this.seedHostProtocolConfigs(
      id,
      defaultProtocolConfigs().map((profile) => ({ ...profile, enabled: false }))
    );
    return { host: this.getHost(id), enrollmentToken };
  }

  rotateNodeEnrollmentToken(hostId) {
    const host = this.getHost(hostId);
    if (!host || host.kind !== "remote") {
      throw domainError("HOST_NOT_FOUND", "远程主机不存在", 404);
    }
    if (host.enrolledAt) {
      throw domainError("NODE_ALREADY_ENROLLED", "节点已经注册，不能重新生成接入令牌", 409);
    }
    const enrollmentToken = createSessionSecret();
    this.db.prepare(`
      UPDATE hosts
      SET enrollment_secret_hash = ?, status = 'pending', updated_at = ?
      WHERE id = ?
    `).run(hashSessionSecret(enrollmentToken), nowIso(), hostId);
    return { host: this.getHost(hostId), enrollmentToken };
  }

  updateHost(id, input) {
    this.db.exec("SAVEPOINT update_host");
    try {
      const current = this.getHost(id);
      const next = this.normalizeHostUpdate(id, input);
      this.db.prepare(`
        UPDATE hosts SET name = ?, address = ?, region = ?, updated_at = ? WHERE id = ?
      `).run(next.name, next.address, next.region, nowIso(), id);
      if (current.address !== next.address) {
        this.db.prepare(`
          UPDATE protocol_activations
          SET state_json = json_remove(state_json, '$.publicCheck'), updated_at = ?
          WHERE host_id = ?
        `).run(nowIso(), id);
      }
      this.db.exec("RELEASE update_host");
      return this.getHost(id);
    } catch (error) {
      this.db.exec("ROLLBACK TO update_host; RELEASE update_host");
      throw error;
    }
  }

  normalizeHostUpdate(id, input) {
    const current = this.getHost(id);
    if (!current) throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    const next = normalizedHostInput(input, current);
    if (current.endpointDomain && current.address !== next.address) {
      throw domainError(
        "HOST_DOMAIN_MIGRATION_REQUIRED",
        "此主机已绑定业务域名，不能直接修改 IP；请先规划节点与 DNS 绑定迁移。原地址和订阅保持不变",
        409
      );
    }
    return next;
  }

  updateLocalRuntimeCapabilities(runtime = {}) {
    const buildTags = Array.isArray(runtime.tags)
      ? runtime.tags.map(String).filter((tag) => /^[a-zA-Z0-9_-]{1,64}$/.test(tag)).slice(0, 64)
      : [];
    this.db.prepare(`
      UPDATE hosts
      SET runtime_version = COALESCE(?, runtime_version),
          platform = COALESCE(?, platform),
          architecture = COALESCE(?, architecture),
          build_tags_json = ?,
          updated_at = ?
      WHERE id = 'local'
    `).run(
      runtime.version ? String(runtime.version).slice(0, 64) : null,
      runtime.platform ? String(runtime.platform).slice(0, 64) : null,
      runtime.architecture ? String(runtime.architecture).slice(0, 64) : null,
      JSON.stringify(buildTags),
      nowIso()
    );
    return this.getHost("local");
  }

  enrollNode(token, metadata = {}) {
    const row = this.db.prepare(`
      SELECT id FROM hosts
      WHERE kind = 'remote' AND enrollment_secret_hash = ?
    `).get(hashSessionSecret(String(token || "")));
    if (!row) throw domainError("NODE_ENROLLMENT_INVALID", "节点注册令牌无效或已经使用", 401);

    const nodeSecret = createSessionSecret();
    const timestamp = nowIso();
    const buildTags = Array.isArray(metadata.buildTags)
      ? metadata.buildTags.map(String).filter((tag) => /^[a-zA-Z0-9_-]{1,64}$/.test(tag)).slice(0, 64)
      : [];
    const encryptionPublicKey = String(metadata.encryptionPublicKey || "").slice(0, 4_096) || null;
    this.db.prepare(`
      UPDATE hosts
      SET enrollment_secret_hash = NULL, node_secret_hash = ?, status = 'online',
          hostname = ?, platform = ?, architecture = ?, agent_version = ?,
          runtime_version = ?, build_tags_json = ?, encryption_public_key = ?, last_seen_at = ?,
          enrolled_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      hashSessionSecret(nodeSecret),
      String(metadata.hostname || "").slice(0, 255) || null,
      String(metadata.platform || "").slice(0, 64) || null,
      String(metadata.architecture || "").slice(0, 64) || null,
      String(metadata.agentVersion || "").slice(0, 64) || null,
      String(metadata.runtimeVersion || "").slice(0, 64) || null,
      JSON.stringify(buildTags),
      encryptionPublicKey,
      timestamp,
      timestamp,
      timestamp,
      row.id
    );
    return { hostId: row.id, nodeSecret };
  }

  authenticateNode(hostId, secret) {
    if (!hostId || !secret) return null;
    const row = this.db.prepare(`
      SELECT id, agent_version AS agentVersion FROM hosts
      WHERE id = ? AND kind = 'remote' AND node_secret_hash = ?
    `).get(hostId, hashSessionSecret(secret));
    return row || null;
  }

  heartbeatNode(hostId, input = {}) {
    const current = this.getHost(hostId);
    if (!current || current.kind !== "remote") {
      throw domainError("NODE_NOT_FOUND", "节点不存在", 404);
    }
    const reportedRuntimeState = String(input.runtimeState || "");
    const reportedServiceStatus = normalizeTelemetry(input.telemetry).serviceStatus;
    const runtimeState = reportedRuntimeState === "running" || reportedServiceStatus === "running"
      ? "online"
      : ["staged", "stopped", "failed"].includes(reportedRuntimeState)
          || ["staged", "stopped", "failed"].includes(reportedServiceStatus)
        ? "degraded"
        : current.status === "degraded"
          ? "degraded"
          : "online";
    const timestamp = nowIso();
    const buildTags = Array.isArray(input.buildTags)
      ? input.buildTags.map(String).filter((tag) => /^[a-zA-Z0-9_-]{1,64}$/.test(tag)).slice(0, 64)
      : null;
    const encryptionPublicKey = input.encryptionPublicKey
      ? String(input.encryptionPublicKey).slice(0, 4_096)
      : null;
    this.db.prepare(`
      UPDATE hosts
      SET status = ?, runtime_version = COALESCE(?, runtime_version),
          agent_version = COALESCE(?, agent_version),
          build_tags_json = COALESCE(?, build_tags_json),
          encryption_public_key = COALESCE(?, encryption_public_key),
          last_seen_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      runtimeState,
      input.runtimeVersion ? String(input.runtimeVersion).slice(0, 64) : null,
      input.agentVersion ? String(input.agentVersion).slice(0, 64) : null,
      buildTags ? JSON.stringify(buildTags) : null,
      encryptionPublicKey,
      timestamp,
      timestamp,
      hostId
    );
    if (input.telemetry && typeof input.telemetry === "object") {
      this.recordHostTelemetry(hostId, input.telemetry, timestamp);
    }
    return this.getHost(hostId);
  }

  recordHostTelemetry(hostId, input = {}, timestamp = nowIso()) {
    const host = this.getHost(hostId);
    if (!host) throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    const telemetry = normalizeTelemetry(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE hosts
        SET cpu_percent = ?, memory_used_bytes = ?, memory_total_bytes = ?,
            disk_used_bytes = ?, disk_total_bytes = ?,
            network_rx_bytes = ?, network_tx_bytes = ?,
            network_rx_bps = ?, network_tx_bps = ?, service_status = ?,
            bbr_json = ?,
            metrics_updated_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        telemetry.cpuPercent,
        telemetry.memoryUsedBytes,
        telemetry.memoryTotalBytes,
        telemetry.diskUsedBytes,
        telemetry.diskTotalBytes,
        telemetry.networkRxBytes,
        telemetry.networkTxBytes,
        telemetry.networkRxBps,
        telemetry.networkTxBps,
        telemetry.serviceStatus,
        JSON.stringify(normalizeBbr(input.bbr, timestamp)),
        timestamp,
        timestamp,
        hostId
      );
      const latestSample = this.db.prepare(`
        SELECT id, recorded_at
        FROM host_metric_samples
        WHERE host_id = ?
        ORDER BY recorded_at DESC
        LIMIT 1
      `).get(hostId);
      const currentBucket = Math.floor(new Date(timestamp).getTime() / 300_000);
      const latestBucket = latestSample
        ? Math.floor(new Date(latestSample.recorded_at).getTime() / 300_000)
        : null;
      if (latestSample && currentBucket === latestBucket) {
        this.db.prepare(`
          UPDATE host_metric_samples
          SET cpu_percent = ?, memory_used_bytes = ?, memory_total_bytes = ?,
              network_rx_bytes = ?, network_tx_bytes = ?,
              network_rx_bps = ?, network_tx_bps = ?, service_status = ?,
              recorded_at = ?
          WHERE id = ?
        `).run(
          telemetry.cpuPercent,
          telemetry.memoryUsedBytes,
          telemetry.memoryTotalBytes,
          telemetry.networkRxBytes,
          telemetry.networkTxBytes,
          telemetry.networkRxBps,
          telemetry.networkTxBps,
          telemetry.serviceStatus,
          timestamp,
          latestSample.id
        );
      } else {
        this.db.prepare(`
          INSERT INTO host_metric_samples (
            host_id, cpu_percent, memory_used_bytes, memory_total_bytes,
            network_rx_bytes, network_tx_bytes, network_rx_bps, network_tx_bps,
            service_status, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          hostId,
          telemetry.cpuPercent,
          telemetry.memoryUsedBytes,
          telemetry.memoryTotalBytes,
          telemetry.networkRxBytes,
          telemetry.networkTxBytes,
          telemetry.networkRxBps,
          telemetry.networkTxBps,
          telemetry.serviceStatus,
          timestamp
        );
      }
      if (Date.now() - this.lastTelemetryPruneAt >= 60 * 60 * 1000) {
        this.db.prepare(`
          DELETE FROM host_metric_samples
          WHERE recorded_at < ?
        `).run(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
        this.lastTelemetryPruneAt = Date.now();
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getHost(hostId).telemetry;
  }

  telemetryOverview(hours = 24) {
    const boundedHours = Math.min(168, Math.max(1, Number(hours) || 24));
    const since = new Date(Date.now() - boundedHours * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      WITH per_host AS (
        SELECT
          (unixepoch(recorded_at) / 300) * 300 AS bucket_epoch,
          host_id,
          AVG(COALESCE(network_rx_bps, 0)) AS download_bps,
          AVG(COALESCE(network_tx_bps, 0)) AS upload_bps
        FROM host_metric_samples
        WHERE recorded_at >= ?
        GROUP BY bucket_epoch, host_id
      )
      SELECT
        bucket_epoch,
        SUM(download_bps) AS download_bps,
        SUM(upload_bps) AS upload_bps
      FROM per_host
      GROUP BY bucket_epoch
      ORDER BY bucket_epoch
    `).all(since);
    return {
      windowHours: boundedHours,
      networkSeries: rows.map((row) => ({
        recordedAt: new Date(Number(row.bucket_epoch) * 1000).toISOString(),
        downloadBps: Number(row.download_bps || 0),
        uploadBps: Number(row.upload_bps || 0)
      }))
    };
  }

  queueNodeTask(hostId, kind, payload, options = {}) {
    const host = this.getHost(hostId);
    if (!host || host.kind !== "remote" || !host.enrolledAt) {
      throw domainError("NODE_NOT_ENROLLED", "远程节点尚未完成注册", 409);
    }
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let priority = options.priority === "critical"
        ? 100
        : Math.max(0, Number(options.priority) || 0);
      let maxAttempts = options.maxAttempts === 0
        ? 0
        : Math.max(1, Number(options.maxAttempts) || 5);
      if (kind === "publish-config") {
        const superseded = this.db.prepare(`
          SELECT MAX(priority) AS priority,
                 MIN(CASE WHEN max_attempts = 0 THEN 0 ELSE max_attempts END) AS max_attempts
          FROM node_tasks
          WHERE host_id = ? AND kind = 'publish-config' AND status = 'pending'
        `).get(hostId);
        priority = Math.max(priority, Number(superseded?.priority || 0));
        if (Number(superseded?.max_attempts) === 0 && Number(superseded?.priority) >= 100) {
          maxAttempts = 0;
        }
        this.db.prepare(`
          DELETE FROM node_tasks
          WHERE host_id = ? AND kind = 'publish-config' AND status = 'pending'
        `).run(hostId);
      } else if (["upgrade-runtime", "upgrade-node", "configure-bbr"].includes(kind)) {
        this.db.prepare(`
          DELETE FROM node_tasks
          WHERE host_id = ? AND kind = ? AND status = 'pending'
        `).run(hostId, kind);
      }
      this.db.prepare(`
        INSERT INTO node_tasks (
          id, host_id, kind, payload_json, status, priority, max_attempts, created_at
        )
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(id, hostId, kind, JSON.stringify(payload), priority, maxAttempts, nowIso());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return id;
  }

  latestAppliedNodeConfig(hostId) {
    const row = this.db.prepare(`
      SELECT payload_json
      FROM node_tasks
      WHERE host_id = ? AND kind = 'publish-config' AND status = 'succeeded'
      ORDER BY finished_at DESC
      LIMIT 1
    `).get(hostId);
    const payload = parseJson(row?.payload_json, {});
    if (!payload.configText) return null;
    return parseJson(payload.configText, null);
  }

  nextNodeTask(hostId) {
    const now = nowIso();
    const retryBefore = new Date(Date.now() - 60_000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A missing completion must not let an expired lease resurrect a
      // superseded configuration after a newer publication was applied.
      this.db.prepare(`
        UPDATE node_tasks AS older
        SET status = 'failed', result_json = '{"superseded":true}',
            finished_at = ?, next_attempt_at = NULL
        WHERE host_id = ? AND kind = 'publish-config'
          AND status IN ('pending', 'claimed')
          AND EXISTS (
            SELECT 1 FROM node_tasks AS newer
            WHERE newer.host_id = older.host_id AND newer.kind = 'publish-config'
              AND newer.rowid > older.rowid
          )
      `).run(now, hostId);
      const task = this.db.prepare(`
        SELECT id, kind, payload_json, priority, attempt_count
        FROM node_tasks
        WHERE host_id = ?
          AND (
            (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
            OR (status = 'claimed' AND claimed_at < ?)
          )
        ORDER BY priority DESC, created_at DESC
        LIMIT 1
      `).get(hostId, now, retryBefore);
      if (!task) {
        this.db.exec("COMMIT");
        return null;
      }
      const claimed = this.db.prepare(`
        UPDATE node_tasks
        SET status = 'claimed', claimed_at = ?, attempt_count = attempt_count + 1
        WHERE id = ?
          AND host_id = ?
          AND (
            (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
            OR (status = 'claimed' AND claimed_at < ?)
          )
      `).run(now, task.id, hostId, now, retryBefore);
      this.db.exec("COMMIT");
      if (claimed.changes !== 1) return null;
      return {
        id: task.id,
        kind: task.kind,
        payload: parseJson(task.payload_json, {}),
        priority: Number(task.priority) >= 100 ? "critical" : "normal",
        attempt: Number(task.attempt_count) + 1
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeNodeTask(hostId, taskId, input = {}) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.db.prepare(`
        SELECT rowid AS sequence, id, kind, status, attempt_count, max_attempts, payload_json
        FROM node_tasks
        WHERE id = ? AND host_id = ?
      `).get(taskId, hostId);
      if (!task) throw domainError("NODE_TASK_NOT_FOUND", "节点任务不存在", 404);
      const attempt = Number(input.attempt);
      if (
        task.status !== "claimed"
        || !Number.isInteger(attempt)
        || attempt !== Number(task.attempt_count)
      ) {
        this.db.exec("COMMIT");
        return { id: taskId, status: task.status, ignored: true };
      }
      const superseded = task.kind === "publish-config" && this.db.prepare(`
        SELECT 1 FROM node_tasks
        WHERE host_id = ? AND kind = 'publish-config' AND rowid > ?
        LIMIT 1
      `).get(hostId, task.sequence);
      if (superseded) {
        const timestamp = nowIso();
        this.db.prepare(`
          UPDATE node_tasks
          SET status = 'failed', result_json = ?, finished_at = ?, next_attempt_at = NULL
          WHERE id = ? AND host_id = ?
        `).run(JSON.stringify({ ...input, superseded: true }), timestamp, taskId, hostId);
        this.db.exec("COMMIT");
        return { id: taskId, status: "failed", ignored: true, superseded: true };
      }
      const succeeded = input.status === "succeeded";
      const payload = parseJson(task.payload_json, {});
      const activationPortOccupied = input.result?.code === "PROTOCOL_PORT_OCCUPIED"
        && payload.activation?.type;
      const canRetryActivationPort = activationPortOccupied
        && Number.isInteger(input.result?.suggestedPort);
      const retryable = !succeeded
        && task.kind === "publish-config"
        && !activationPortOccupied
        && (Number(task.max_attempts) === 0 || Number(task.attempt_count) < Number(task.max_attempts));
      const status = succeeded ? "succeeded" : retryable ? "pending" : "failed";
      const timestamp = nowIso();
      const retryDelayMs = this.nodeTaskRetryBaseMs * Math.min(
        16,
        2 ** Math.max(0, Number(task.attempt_count) - 1)
      );
      const retryAt = retryable
        ? new Date(Date.now() + retryDelayMs).toISOString()
        : null;
      this.db.prepare(`
        UPDATE node_tasks
        SET status = ?, result_json = ?, finished_at = ?,
            claimed_at = ?, next_attempt_at = ?
        WHERE id = ? AND host_id = ? AND status = 'claimed' AND attempt_count = ?
      `).run(
        status,
        JSON.stringify(input),
        retryable ? null : timestamp,
        retryable ? null : timestamp,
        retryAt,
        taskId,
        hostId,
        attempt
      );
      this.db.prepare(`
        UPDATE hosts
        SET status = ?, runtime_version = COALESCE(?, runtime_version),
            last_seen_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        succeeded ? "online" : "degraded",
        input.result?.runtimeVersion
          ? String(input.result.runtimeVersion).slice(0, 64)
          : input.runtimeVersion
            ? String(input.runtimeVersion).slice(0, 64)
            : null,
        timestamp,
        timestamp,
        hostId
      );
      if (succeeded && task.kind === "publish-config") {
        if (Array.isArray(payload.protocols)) {
          this.markHostProtocolsApplied(hostId, payload.protocols);
        }
        if (payload.activation?.type) {
          const publicCheck = input.result?.activation?.publicCheck;
          const persistedPublicCheck = publicCheck
            ? {
                ...publicCheck,
                checkedAt: publicCheck.checkedAt || timestamp
              }
            : null;
          this.setProtocolActivation(
            hostId,
            payload.activation.type,
            {
              state: publicCheck?.reachable === true ? "public-ready" : "port-listening",
              progress: 100,
              port: payload.activation.port,
              network: payload.activation.network,
              firewallManaged: input.result?.activation?.firewallManaged === true,
              publicCheck: persistedPublicCheck,
              updatedAt: timestamp
            }
          );
        }
      } else if (!succeeded && task.kind === "publish-config" && payload.activation?.type) {
        if (!retryable && payload.activation.previousProfile) {
          this.updateHostProtocolConfig(
            hostId,
            payload.activation.type,
            payload.activation.previousProfile
          );
        }
        this.setProtocolActivation(hostId, payload.activation.type, {
          state: retryable ? "deploying" : "failed",
          progress: retryable ? 60 : 100,
          port: payload.activation.port,
          network: payload.activation.network,
          errorCode: input.result?.code || null,
          ...(Number.isInteger(input.result?.suggestedPort)
            ? { suggestedPort: input.result.suggestedPort }
            : {}),
          error: String(
            [
              input.result?.error || input.error || "远程节点部署失败",
              input.result?.rollbackError
                ? `回滚异常：${input.result.rollbackError}`
                : ""
            ].filter(Boolean).join("；")
          ).slice(0, 500),
          rolledBack: !retryable && input.result?.rolledBack !== false,
          updatedAt: timestamp
        });
      }
      this.db.exec("COMMIT");
      return {
        id: taskId,
        status,
        ...(canRetryActivationPort && status === "failed"
          ? {
              retryActivation: {
                hostId,
                type: payload.activation.type,
                failedPort: payload.activation.port,
                suggestedPort: input.result.suggestedPort
              }
            }
          : {}),
        ...(retryAt ? { retryAt } : {})
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  bootstrap(admin) {
    return {
      currentAdmin: { id: admin.id, username: admin.username, role: admin.role || "owner" },
      users: this.listUsers(),
      hosts: this.listHosts()
    };
  }

  createUser(input) {
    const name = String(input.name || "").trim();
    const email = String(input.email || "").trim().toLowerCase();
    const entitlement = {
      quotaGb: Number(input.quotaGb),
      nodeScope: input.nodeScope
    };
    if (!name) throw domainError("INVALID_USER_NAME", "用户名称不能为空");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw domainError("INVALID_EMAIL", "邮箱地址格式不正确");
    }
    validateUserEntitlement(entitlement);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.expiresAt || ""))) {
      throw domainError("INVALID_EXPIRY", "到期时间格式必须为 YYYY-MM-DD");
    }
    const portalStatus = input.portalStatus === undefined ? "invited" : String(input.portalStatus);
    if (!["active", "invited"].includes(portalStatus)) {
      throw domainError("INVALID_PORTAL_STATUS", "用户中心状态不正确");
    }
    const state = input.state === undefined ? "active" : String(input.state);
    if (!["active", "warning", "disabled"].includes(state)) {
      throw domainError("INVALID_USER_STATE", "用户状态不正确");
    }
    const usedGb = input.usedGb === undefined ? 0 : Number(input.usedGb);
    if (!Number.isFinite(usedGb) || usedGb < 0) {
      throw domainError("INVALID_USAGE", "已用流量必须是大于或等于 0 的数值");
    }
    if (input.password !== undefined) validateUserPassword(input.password);

    const id = randomUUID();
    const initials = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "新";
    const timestamp = nowIso();
    try {
      this.db.prepare(`
        INSERT INTO users (
          id, name, initials, email, password_hash, portal_status, state, used_gb, used_bytes,
          plan_id, quota_gb, device_limit, node_scope_json, client_formats_json,
          expires_at, runtime_uuid, runtime_password, subscription_public_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        name,
        initials,
        email,
        hashPassword(input.password || createRuntimePassword(12)),
        portalStatus,
        state,
        usedGb,
        Math.round(usedGb * GIBIBYTE),
        LEGACY_ENTITLEMENT_PLAN_ID,
        entitlement.quotaGb,
        1,
        JSON.stringify(entitlement.nodeScope),
        LEGACY_CLIENT_FORMATS_JSON,
        input.expiresAt,
        randomUUID(),
        createShadowsocksKey(),
        createRuntimePassword(18),
        timestamp,
        timestamp
      );
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw domainError("USER_EXISTS", "邮箱已经存在", 409);
      }
      throw error;
    }
    return this.getUser(id);
  }

  getUser(id) {
    const row = this.db.prepare(`
      SELECT id, name, initials, email, portal_status, state, used_gb, used_bytes, quota_gb,
             node_scope_json, expires_at,
             subscription_public_id, subscription_secret_hash,
             subscription_secret_encrypted
      FROM users WHERE id = ?
    `).get(id);
    return row ? userFromRow(row) : null;
  }

  updateUser(id, input) {
    const current = this.getUser(id);
    if (!current) throw domainError("USER_NOT_FOUND", "用户不存在", 404);
    const next = {
      name: input.name === undefined ? current.name : String(input.name).trim(),
      email: input.email === undefined ? current.email : String(input.email).trim().toLowerCase(),
      quotaGb: input.quotaGb === undefined ? current.quotaGb : Number(input.quotaGb),
      nodeScope: input.nodeScope === undefined ? current.nodeScope : input.nodeScope,
      expiresAt: input.expiresAt === undefined ? current.expiresAt : String(input.expiresAt),
      state: input.state === undefined ? current.state : String(input.state),
      portalStatus: input.portalStatus === undefined ? current.portalStatus : String(input.portalStatus),
      usedGb: input.usedGb === undefined ? current.usedGb : Number(input.usedGb)
    };
    if (!next.name) throw domainError("INVALID_USER_NAME", "用户名称不能为空");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) {
      throw domainError("INVALID_EMAIL", "邮箱地址格式不正确");
    }
    validateUserEntitlement(next);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next.expiresAt)) {
      throw domainError("INVALID_EXPIRY", "到期时间格式必须为 YYYY-MM-DD");
    }
    if (!["active", "warning", "disabled"].includes(next.state)) {
      throw domainError("INVALID_USER_STATE", "用户状态不正确");
    }
    if (!["active", "invited"].includes(next.portalStatus)) {
      throw domainError("INVALID_PORTAL_STATUS", "用户中心状态不正确");
    }
    if (!Number.isFinite(next.usedGb) || next.usedGb < 0) {
      throw domainError("INVALID_USAGE", "已用流量必须是大于或等于 0 的数值");
    }
    if (input.password !== undefined) validateUserPassword(input.password);
    const initials = next.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || current.initials;
    try {
      this.db.prepare(`
        UPDATE users
        SET name = ?, initials = ?, email = ?, quota_gb = ?,
            node_scope_json = ?, expires_at = ?,
            state = ?, portal_status = ?, used_gb = ?, used_bytes = ?, updated_at = ?
        WHERE id = ?
      `).run(
        next.name,
        initials,
        next.email,
        next.quotaGb,
        JSON.stringify(next.nodeScope),
        next.expiresAt,
        next.state,
        next.portalStatus,
        next.usedGb,
        Math.round(next.usedGb * GIBIBYTE),
        nowIso(),
        id
      );
      if (input.password !== undefined) {
        this.resetUserPassword(id, input.password);
      }
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw domainError("USER_EXISTS", "邮箱已经存在", 409);
      }
      throw error;
    }
    return this.getUser(id);
  }

  resetUserPassword(id, password) {
    if (!this.getUser(id)) {
      throw domainError("USER_NOT_FOUND", "用户不存在", 404);
    }
    const nextPassword = validateUserPassword(password);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE users
        SET password_hash = ?, updated_at = ?
        WHERE id = ?
      `).run(hashPassword(nextPassword), nowIso(), id);
      const sessions = this.db.prepare(
        "DELETE FROM user_sessions WHERE user_id = ?"
      ).run(id);
      this.db.exec("COMMIT");
      return {
        passwordReset: true,
        sessionsRevoked: Number(sessions.changes)
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  runtimeSnapshot(hostId = "local") {
    const host = this.db.prepare(`
      SELECT id, name, address, endpoint_domain AS endpointDomain, kind, region, status, build_tags_json, runtime_version AS runtimeVersion
      FROM hosts
      WHERE id = ?
    `).get(hostId);
    if (!host) throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    host.buildTags = parseJson(host.build_tags_json, []);
    delete host.build_tags_json;
    const setting = this.db.prepare("SELECT value FROM settings WHERE key = 'shadowsocks_master_password'").get();
    const users = this.db.prepare(`
      SELECT users.email, users.state, users.portal_status, users.used_gb, users.expires_at,
             users.runtime_uuid, users.runtime_password, users.quota_gb, users.node_scope_json
      FROM users
      ORDER BY users.email
    `).all().map((row) => ({
      email: row.email,
      state: row.state,
      portalStatus: row.portal_status,
      usedGb: row.used_gb,
      quotaGb: row.quota_gb,
      expiresAt: row.expires_at,
      runtimeUuid: row.runtime_uuid,
      runtimePassword: row.runtime_password,
      nodeScope: parseJson(row.node_scope_json, [])
    }));
    return {
      host,
      masterPassword: setting.value,
      users,
      protocols: this.listHostProtocolConfigs(hostId)
    };
  }

  listHostProtocolConfigs(hostId) {
    const hostExists = this.db.prepare("SELECT 1 FROM hosts WHERE id = ?").get(hostId);
    if (!hostExists) throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    const rows = this.db.prepare(`
      SELECT type, config_json
      FROM host_protocols
      WHERE host_id = ?
    `).all(hostId);
    const stored = new Map(rows.map((row) => [row.type, parseJson(row.config_json, null)]));
    const defaults = defaultProtocolConfigs().map((profile) => ({ ...profile, enabled: false }));
    return normalizeProtocolConfigs(defaults.map((profile) => stored.get(profile.type) || profile));
  }

  listProtocolActivations(hostId) {
    return this.db.prepare(`
      SELECT type, state_json
      FROM protocol_activations
      WHERE host_id = ?
      ORDER BY type
    `).all(hostId).map((row) => ({
      type: row.type,
      ...parseJson(row.state_json, { state: "disabled" })
    }));
  }

  setProtocolActivation(hostId, type, activation) {
    if (!this.db.prepare("SELECT 1 FROM hosts WHERE id = ?").get(hostId)) {
      throw domainError("HOST_NOT_FOUND", "主机不存在", 404);
    }
    const value = {
      state: String(activation?.state || "disabled"),
      ...activation
    };
    const updatedAt = nowIso();
    this.db.prepare(`
      INSERT INTO protocol_activations (host_id, type, state_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(host_id, type) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(hostId, type, JSON.stringify(value), updatedAt);
    return { type, ...value, updatedAt: value.updatedAt || updatedAt };
  }

  prepareHostProtocolConfig(hostId, type, input) {
    const profiles = this.listHostProtocolConfigs(hostId);
    const index = profiles.findIndex((profile) => profile.type === type);
    if (index < 0) throw domainError("PROTOCOL_NOT_FOUND", "sing-box 入站协议不存在", 404);
    const current = profiles[index];
    const next = normalizeProtocolConfig({
      ...current,
      ...input,
      type,
      tls: { ...current.tls, ...(input.tls || {}) },
      transport: { ...current.transport, ...(input.transport || {}) },
      options: input.options === undefined ? current.options : input.options
    });
    assertProtocolSet(profiles.toSpliced(index, 1, next));
    return next;
  }

  updateHostProtocolConfig(hostId, type, input) {
    // This can also run during a task-completion rollback; a savepoint keeps
    // the configuration and evidence atomic within that outer transaction.
    this.db.exec("SAVEPOINT update_protocol");
    try {
      const current = this.listHostProtocolConfigs(hostId).find((profile) => profile.type === type);
      const next = this.prepareHostProtocolConfig(hostId, type, input);
      this.db.prepare(`
        INSERT INTO host_protocols (host_id, type, config_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(host_id, type) DO UPDATE SET
          config_json = excluded.config_json,
          updated_at = excluded.updated_at
      `).run(hostId, type, JSON.stringify(next), nowIso());
      if (JSON.stringify(current) !== JSON.stringify(next)) {
        this.db.prepare(`
          UPDATE protocol_activations
          SET state_json = json_remove(state_json, '$.publicCheck'), updated_at = ?
          WHERE host_id = ? AND type = ?
        `).run(nowIso(), hostId, type);
      }
      this.db.exec("RELEASE update_protocol");
      return next;
    } catch (error) {
      this.db.exec("ROLLBACK TO update_protocol; RELEASE update_protocol");
      throw error;
    }
  }

  createDeployment({
    version,
    configJson,
    checksum,
    eligibleUsers,
    protocols = [],
    hostSnapshots = [],
    publisherAdminId = null
  }) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO deployments (
        id, version, status, config_json, error_json, publisher_admin_id, created_at, published_at
      ) VALUES (?, ?, 'validating', ?, NULL, ?, ?, NULL)
    `).run(
      id,
      version,
      JSON.stringify({
        config: configJson,
        checksum,
        eligibleUsers,
        protocols,
        hostSnapshots
      }),
      publisherAdminId,
      nowIso()
    );
    return id;
  }

  finishDeployment(id, { status, error = null }) {
    if (status === "active") {
      this.db.prepare(`
        UPDATE deployments SET status = 'superseded' WHERE status = 'active' AND id <> ?
      `).run(id);
    }
    this.db.prepare(`
      UPDATE deployments
      SET status = ?, error_json = ?, published_at = ?
      WHERE id = ?
    `).run(status, error ? JSON.stringify({ message: error }) : null, status === "active" ? nowIso() : null, id);
  }

  listDeployments(limit = 20) {
    const rows = this.db.prepare(`
      SELECT deployments.id, deployments.version, deployments.status, deployments.config_json,
             deployments.error_json, deployments.created_at, deployments.published_at,
             admins.username AS publisher_username
      FROM deployments
      LEFT JOIN admins ON admins.id = deployments.publisher_admin_id
      ORDER BY deployments.created_at DESC
      LIMIT ?
    `).all(limit);
    const hostNames = new Map(this.db.prepare(
      "SELECT id, name, address FROM hosts"
    ).all().map((host) => [host.id, host]));
    const latestTasks = new Map();
    for (const task of this.db.prepare(`
      SELECT host_id, status, payload_json, result_json, created_at, claimed_at, finished_at
      FROM node_tasks
      WHERE kind = 'publish-config'
      ORDER BY created_at DESC
    `).all()) {
      const payload = parseJson(task.payload_json, {});
      if (!payload.version) continue;
      const key = `${payload.version}:${task.host_id}`;
      if (!latestTasks.has(key)) {
        latestTasks.set(key, {
          ...task,
          payload,
          result: parseJson(task.result_json, null)
        });
      }
    }
    return rows.map((row) => {
      const metadata = parseJson(row.config_json, {});
      const error = parseJson(row.error_json, null);
      const localStatus = row.status === "failed"
        ? "failed"
        : row.status === "validating"
          ? "deploying"
          : row.status === "superseded"
            ? "superseded"
            : "applied";
      const targets = [{
        hostId: "local",
        name: hostNames.get("local")?.name || "RayLink Control Plane",
        address: hostNames.get("local")?.address || null,
        certificates: [],
        status: localStatus,
        updatedAt: row.published_at || row.created_at,
        error: error?.message || null
      }, ...(Array.isArray(metadata.hostSnapshots) ? metadata.hostSnapshots : []).map((snapshot) => {
        const task = latestTasks.get(`${row.version}:${snapshot.hostId}`);
        const statuses = {
          pending: "pending",
          claimed: "deploying",
          succeeded: "applied",
          failed: "failed"
        };
        const host = hostNames.get(snapshot.hostId);
        return {
          hostId: snapshot.hostId,
          name: host?.name || snapshot.hostId,
          address: host?.address || null,
          certificates: Array.isArray(snapshot.tlsAssets)
            ? snapshot.tlsAssets.map((asset) => ({
                name: asset.name,
                fingerprint256: asset.fingerprint256,
                validTo: asset.validTo
              }))
            : [],
          status: task ? statuses[task.status] : "not-queued",
          updatedAt: task?.finished_at || task?.claimed_at || task?.created_at || row.created_at,
          error: task?.result?.error || null
        };
      })];
      const rolloutStatus = row.status === "failed"
        ? "failed"
        : row.status === "validating"
          ? "deploying"
          : row.status === "superseded"
            ? "superseded"
            : targets.some((target) => target.status === "failed")
              ? "failed"
              : targets.every((target) => target.status === "applied")
                ? "complete"
                : "pending";
      return {
        id: row.id,
        version: row.version,
        status: row.status,
        rolloutStatus,
        targets,
        checksum: metadata.checksum,
        eligibleUsers: metadata.eligibleUsers,
        error: error?.message || null,
        publisherUsername: row.publisher_username || null,
        createdAt: row.created_at,
        publishedAt: row.published_at
      };
    });
  }

  deploymentSnapshot(id) {
    const row = this.db.prepare(`
      SELECT id, version, status, config_json FROM deployments WHERE id = ?
    `).get(id);
    if (!row) throw domainError("DEPLOYMENT_NOT_FOUND", "部署记录不存在", 404);
    const metadata = parseJson(row.config_json, {});
    if (!metadata.config) throw domainError("DEPLOYMENT_SNAPSHOT_MISSING", "部署快照不可用", 409);
    const inboundTypes = new Set(metadata.config.inbounds?.map((inbound) => inbound.type) || []);
    const protocols = Array.isArray(metadata.protocols) && metadata.protocols.length
      ? normalizeProtocolConfigs(metadata.protocols)
      : this.listHostProtocolConfigs("local").map((profile) => ({
          ...profile,
          enabled: inboundTypes.has(profile.type)
        }));
    return {
      id: row.id,
      version: row.version,
      status: row.status,
      config: metadata.config,
      checksum: metadata.checksum,
      eligibleUsers: metadata.eligibleUsers,
      protocols,
      hostSnapshots: Array.isArray(metadata.hostSnapshots) ? metadata.hostSnapshots : []
    };
  }

  close() {
    this.db.close();
  }
}
