import { protocolCatalog, SMART_PROTOCOL_HEALTH_MAX_AGE_MS } from "./singbox/protocol-catalog.js";

function timestamp(value) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Pure, read-only and allowlisted: never copy configs, credentials, raw errors,
// host addresses/names, user identities or backup filesystem paths into exports.
export function buildReadinessReport({
  hosts = [], deployments = [], backups = [], runtime = {}, routingPolicy = {},
  ruleSets = null, alerts = [], backupVerification = null, tlsRenewal = null, now = new Date()
} = {}) {
  const checks = [];
  const fresh = (value, limit) => {
    const time = timestamp(value);
    const age = time ? now.getTime() - new Date(time).getTime() : Infinity;
    return age >= -60_000 && age <= limit;
  };
  const add = (id, status, title, detail, action, target = "hosts", observedAt = null) => {
    checks.push({ id, status, title, detail, action, target, observedAt: timestamp(observedAt) });
  };
  const active = deployments.find((deployment) => deployment.status === "active");
  const latest = deployments[0];
  const targets = active?.targets || [];
  const failed = latest?.status === "failed" || active?.rolloutStatus === "failed" || targets.some((target) => target.status === "failed");
  const complete = !failed && latest === active && active?.rolloutStatus === "complete" && targets.length > 0
    && targets.every((target) => target.status === "applied");
  add("deployment", failed ? "fail" : complete ? "pass" : active ? "warning" : "unknown",
    "配置发布", complete ? `${targets.length} 个目标已确认应用` : failed ? "存在应用失败的目标" : "尚未确认全部目标应用",
    "查看发布记录与目标回执", "maintenance", active?.publishedAt || active?.createdAt);

  if (!hosts.length) add("hosts", "unknown", "主机", "没有主机状态", "接入主机并等待心跳");
  const clientTypes = new Set(protocolCatalog.filter((entry) => entry.clientCapable && entry.exposure === "public").map((entry) => entry.type));
  const hasEntry = hosts.some((host) => host.protocols?.some((profile) => profile.enabled && clientTypes.has(profile.type)));
  add("client-entry", hasEntry ? "pass" : "unknown", "客户端入口",
    hasEntry ? "已配置可导出的客户端入口" : "尚无启用的客户端代理入口，无法交付订阅连接",
    "在主机入口协议中启用并检测协议");
  hosts.forEach((host, index) => {
    const prefix = `host:${index}`;
    const label = `主机 ${index + 1}`;
    const profiles = (host.protocols || []).filter((profile) => profile.enabled);
    const telemetry = host.telemetry || {};
    const seen = telemetry.updatedAt || host.lastSeenAt;
    const remote = host.kind === "remote";
    if (remote || profiles.length) {
      const service = remote ? telemetry.serviceStatus : runtime.state;
      const stopped = ["stopped", "failed", "inactive", "error"].includes(service);
      const online = remote ? host.status === "online" && fresh(seen, 60_000) : runtime.mode === "systemd";
      const status = stopped || (remote && host.status === "offline") ? "fail"
        : !online || !fresh(seen, 60_000) ? "unknown" : service === "running" ? "pass" : "unknown";
      add(`${prefix}:runtime`, status, `${label} · Runtime`,
        status === "pass" ? "运行中，且指标有效" : status === "fail" ? "Runtime 停止或节点离线" : "缺少近期运行证据，或当前为模拟模式",
        "查看主机状态、服务与心跳", "hosts", seen);
    }
    if (host.deploymentSync?.critical) {
      add(`${prefix}:revocation`, "fail", `${label} · 权益撤销`,
        "关键撤销配置尚未确认生效，旧连接权限可能仍有效", "恢复节点通信并检查撤销回执");
    }
    if (!profiles.length) return;
    const metering = host.usageMetering || {};
    const meteringStatus = metering.status === "error" || metering.supported === false ? "fail"
      : metering.status === "healthy" && fresh(metering.lastSampleAt, 2 * 60_000) ? "pass" : "unknown";
    add(`${prefix}:metering`, meteringStatus, `${label} · 流量计量`,
      meteringStatus === "pass" ? "近期用户流量采集正常" : "无法确认配额数据持续更新",
      "检查计量版 Runtime 与用户流量采集", "hosts", metering.lastSampleAt);
    for (const profile of profiles) {
      const health = host.protocolActivations?.find((entry) => entry.type === profile.type)?.publicCheck;
      const current = fresh(health?.checkedAt, SMART_PROTOCOL_HEALTH_MAX_AGE_MS);
      const endToEnd = health?.probe === "sing-box-tools-fetch"
        && health?.layers?.handshake === "passed" && health?.layers?.public === "passed";
      const status = !current || health?.unsupported ? "unknown"
        : health?.availability === "unavailable" ? "fail"
          : health?.availability === "degraded" ? "warning"
            : health?.reachable === true && endToEnd ? "pass" : "unknown";
      add(`${prefix}:protocol:${profile.type}`, status, `${label} · ${profile.type}`,
        status === "pass" ? "近期完整握手与外部访问成功"
          : status === "fail" ? "连续连接失败"
            : status === "warning" ? "连接质量下降或正在复检" : "缺少 15 分钟内的完整协议检测证据",
        "在主机入口协议中重新检测", "hosts", health?.checkedAt);
    }
  });

  if (tlsRenewal && tlsRenewal.status !== "disabled") {
    const status = tlsRenewal.status === "error" ? "fail"
      : tlsRenewal.status === "healthy" && fresh(tlsRenewal.checkedAt, 60 * 60_000) ? "pass" : "warning";
    add("tls-renewal", status, "本机受管证书同步",
      status === "pass" ? "已核对受管证书及运行时副本" : "证书同步异常、临近到期或检查记录过旧",
      "查看证书有效期与同步状态", "certificates", tlsRenewal.checkedAt);
  }

  add("routing", routingPolicy.mode === "smart" ? "pass" : "warning", "智能分流模式",
    routingPolicy.mode === "smart" ? "已启用规则、DNS 与出口协同分流" : "当前未启用智能分流模式",
    "查看路由策略与域名诊断", "routing");
  add("rule-sets", !ruleSets?.available ? "unknown" : ruleSets.degraded ? "warning" : "pass",
    "分流规则库", !ruleSets?.available ? "规则库可用性尚未确认"
      : ruleSets.degraded ? "正在使用可用缓存，规则维护存在异常" : "已加载经过校验的规则库",
    "查看策略页的规则库版本与状态", "routing", ruleSets?.checkedAt);
  const backup = backups[0];
  const backupStatus = !backup ? "unknown"
    : backupVerification?.valid === false || backup.integrity !== "ok" ? "fail"
      : backupVerification?.valid !== true ? "unknown"
    : fresh(backup.createdAt, 48 * 60 * 60_000) ? "pass" : "warning";
  add("backup", backupStatus, "数据库备份",
    !backup ? "尚无可验证备份" : backupStatus === "fail" ? "最新备份文件、校验和或数据库完整性未通过"
      : backupStatus === "unknown" ? "仅有创建时记录，尚未复核当前备份文件"
        : backupStatus === "pass" ? "48 小时内的备份已通过本次文件与数据库完整性复核" : "最近备份较旧或时间异常，请按恢复目标确认",
    "创建并校验备份；恢复能力仍需演练", "maintenance", backup?.createdAt);
  const critical = alerts.filter((alert) => alert.severity === "critical").length;
  const warnings = alerts.filter((alert) => alert.severity === "warning").length;
  add("alerts", critical ? "fail" : warnings ? "warning" : "pass", "运行告警",
    `${critical} 项严重告警，${warnings} 项警告`, "查看概览告警与对应主机");
  const summary = { pass: 0, fail: 0, warning: 0, unknown: 0 };
  for (const check of checks) summary[check.status] += 1;
  return {
    schemaVersion: 1, generatedAt: now.toISOString(),
    status: summary.fail ? "blocked" : summary.warning || summary.unknown ? "attention" : "healthy",
    summary, checks,
    limitations: [
      "本报告汇总控制面已有证据并复核最新备份；刷新不会发起测速或重启服务。",
      "未验证用户所在地的移动网络、Wi-Fi 切换、吞吐、IPv6/NAT64 或客户端导入。",
      "备份完整性通过不等于恢复演练通过；配置应用成功不等于终端业务可用。"
    ]
  };
}
