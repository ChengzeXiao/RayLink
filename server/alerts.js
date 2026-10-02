import { createHash } from "node:crypto";

const severityOrder = { critical: 0, warning: 1, info: 2 };

function alertId(code, resourceId) {
  return createHash("sha256")
    .update(`${code}:${resourceId || "system"}`)
    .digest("hex")
    .slice(0, 20);
}

function createAlert({
  code,
  severity,
  title,
  message,
  resourceType,
  resourceId,
  createdAt
}) {
  return {
    id: alertId(code, resourceId),
    code,
    severity,
    title,
    message,
    resourceType,
    resourceId,
    createdAt
  };
}

function ageMs(value, now) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? now.getTime() - timestamp : Number.POSITIVE_INFINITY;
}

export function evaluateOperationalAlerts({
  hosts = [],
  deployments = [],
  backups = [],
  tlsRenewal = null,
  now = new Date()
}) {
  const alerts = [];
  const activeDeployment = deployments.find((deployment) => deployment.status === "active");
  if (activeDeployment?.rolloutStatus === "failed") {
    alerts.push(createAlert({
      code: "DEPLOYMENT_TARGET_FAILED",
      severity: "critical",
      title: "配置未在全部节点生效",
      message: `${activeDeployment.version || "当前发布"} 存在失败的 Deployment Target。`,
      resourceType: "deployment",
      resourceId: activeDeployment.id,
      createdAt: activeDeployment.createdAt || now.toISOString()
    }));
  } else if (
    activeDeployment?.rolloutStatus === "pending"
    && ageMs(activeDeployment.createdAt, now) > 5 * 60 * 1000
  ) {
    alerts.push(createAlert({
      code: "DEPLOYMENT_TARGET_PENDING",
      severity: "warning",
      title: "节点配置同步超时",
      message: `${activeDeployment.version || "当前发布"} 超过 5 分钟仍未在全部节点应用。`,
      resourceType: "deployment",
      resourceId: activeDeployment.id,
      createdAt: activeDeployment.createdAt || now.toISOString()
    }));
  }

  for (const host of hosts) {
    const telemetry = host.telemetry || {};
    const stale = ageMs(telemetry.updatedAt || host.lastSeenAt, now) > 60_000;
    const runtimeStopped = telemetry.serviceStatus && telemetry.serviceStatus !== "running";
    const offline = host.kind === "remote"
      ? host.status !== "online" || stale || runtimeStopped
      : runtimeStopped;
    if (offline) {
      alerts.push(createAlert({
        code: "HOST_OFFLINE",
        severity: "critical",
        title: `${host.name} 节点离线`,
        message: stale
          ? "超过 60 秒未收到有效节点指标。"
          : `Runtime 服务状态为 ${telemetry.serviceStatus || host.status || "unknown"}。`,
        resourceType: "host",
        resourceId: host.id,
        createdAt: telemetry.updatedAt || host.lastSeenAt || now.toISOString()
      }));
    }
    const memoryRatio = Number(telemetry.memoryTotalBytes) > 0
      ? Number(telemetry.memoryUsedBytes) / Number(telemetry.memoryTotalBytes)
      : 0;
    if (memoryRatio >= 0.9) {
      alerts.push(createAlert({
        code: "HOST_MEMORY_CRITICAL",
        severity: "critical",
        title: `${host.name} 内存使用过高`,
        message: `内存使用率达到 ${Math.round(memoryRatio * 100)}%。`,
        resourceType: "host",
        resourceId: host.id,
        createdAt: telemetry.updatedAt || now.toISOString()
      }));
    }
    const diskRatio = Number(telemetry.diskTotalBytes) > 0
      ? Number(telemetry.diskUsedBytes) / Number(telemetry.diskTotalBytes)
      : 0;
    if (diskRatio >= 0.9) {
      alerts.push(createAlert({
        code: "HOST_DISK_CRITICAL",
        severity: "critical",
        title: `${host.name} 磁盘空间不足`,
        message: `磁盘使用率达到 ${Math.round(diskRatio * 100)}%。`,
        resourceType: "host",
        resourceId: host.id,
        createdAt: telemetry.updatedAt || now.toISOString()
      }));
    }
    if (["error", "stale"].includes(host.usageMetering?.status)) {
      alerts.push(createAlert({
        code: host.usageMetering.status === "error"
          ? "USAGE_METERING_FAILED"
          : "USAGE_METERING_STALE",
        severity: "warning",
        title: `${host.name} 用户流量计量异常`,
        message: host.usageMetering.lastError
          || (host.usageMetering.status === "stale"
            ? "超过预期时间未收到新的真实流量样本。"
            : "真实流量采集失败。"),
        resourceType: "host",
        resourceId: host.id,
        createdAt: host.usageMetering.lastErrorAt
          || host.usageMetering.lastSampleAt
          || now.toISOString()
      }));
    }
    for (const activation of host.protocolActivations || []) {
      const check = activation.publicCheck;
      if (check?.availability !== "unavailable") continue;
      alerts.push(createAlert({
        code: "PROTOCOL_UNAVAILABLE",
        severity: "critical",
        title: `${host.name} 的 ${activation.type} 不可用`,
        message: `协议连接连续失败 ${Number(check.consecutiveFailures || 0)} 轮。`,
        resourceType: "protocol",
        resourceId: `${host.id}:${activation.type}`,
        createdAt: check.checkedAt || now.toISOString()
      }));
    }
  }

  for (const target of activeDeployment?.targets || []) {
    for (const certificate of target.certificates || []) {
      const remainingMs = new Date(certificate.validTo || 0).getTime() - now.getTime();
      if (!Number.isFinite(remainingMs) || remainingMs > 30 * 24 * 60 * 60 * 1000) continue;
      const expired = remainingMs <= 0;
      const remainingDays = Math.max(0, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
      alerts.push(createAlert({
        code: "CERTIFICATE_EXPIRING",
        severity: expired || remainingDays <= 7 ? "critical" : "warning",
        title: expired ? "节点 TLS 证书已过期" : "节点 TLS 证书即将过期",
        message: expired
          ? `${target.name || target.hostId} 的 ${certificate.name || "TLS"} 证书已经过期。`
          : `${target.name || target.hostId} 的 ${certificate.name || "TLS"} 证书将在 ${remainingDays} 天内过期。`,
        resourceType: "certificate",
        resourceId: `${target.hostId}:${certificate.fingerprint256 || certificate.name || "tls"}`,
        createdAt: now.toISOString()
      }));
    }
  }

  if (tlsRenewal?.status === "error") {
    const rollbackFailed = tlsRenewal.errorCode === "TLS_RENEWAL_ROLLBACK_FAILED";
    alerts.push(createAlert({ code: "TLS_RENEWAL_FAILED", severity: rollbackFailed ? "critical" : "warning",
      title: rollbackFailed ? "本机证书回滚失败" : "本机证书同步失败",
      message: rollbackFailed
        ? "证书更新失败且无法确认回滚成功，请立即人工检查 Runtime 服务和 TLS 入口。"
        : "请查看证书同步状态并检查 TLS 入口，到期前必须恢复同步。",
      resourceType: "certificate", resourceId: "local", createdAt: tlsRenewal.checkedAt || now.toISOString() }));
  }
  for (const certificate of tlsRenewal?.certificates || []) {
    if (!certificate.validTo) continue;
    const remainingMs = new Date(certificate.validTo).getTime() - now.getTime();
    if (!Number.isFinite(remainingMs) || remainingMs > 30 * 86400_000) continue;
    const days = Math.max(0, Math.ceil(remainingMs / 86400_000));
    alerts.push(createAlert({ code: "CERTIFICATE_EXPIRING", severity: days <= 7 ? "critical" : "warning",
      title: days === 0 ? "本机 TLS 证书已过期" : "本机 TLS 证书即将过期",
      message: `${certificate.domain} 的证书${days === 0 ? "已过期" : `将在 ${days} 天内过期`}，请检查自动同步。`,
      resourceType: "certificate", resourceId: `local:${certificate.domain}`, createdAt: now.toISOString() }));
  }

  const latestBackup = backups[0];
  if (!latestBackup) {
    alerts.push(createAlert({
      code: "BACKUP_MISSING",
      severity: "warning",
      title: "尚无数据库在线备份",
      message: "请先执行一次在线备份，之后系统会按计划自动保留备份。",
      resourceType: "backup",
      resourceId: "database",
      createdAt: now.toISOString()
    }));
  } else if (latestBackup.integrity !== "ok") {
    alerts.push(createAlert({
      code: "BACKUP_INVALID",
      severity: "warning",
      title: "数据库备份未通过校验",
      message: "最近一次备份没有通过 SQLite 完整性检查。",
      resourceType: "backup",
      resourceId: "database",
      createdAt: latestBackup.createdAt || now.toISOString()
    }));
  }

  return alerts.sort((left, right) => (
    severityOrder[left.severity] - severityOrder[right.severity]
    || right.createdAt.localeCompare(left.createdAt)
  ));
}
