const users = [];
const subscriptionSession = window.RayLinkSubscriptionSession;
const subscriptionQuick = window.RayLinkSubscriptionQuick;
const protocolHealth = window.RayLinkProtocolHealth;
let bootstrapRefreshTimer = null;
let bootstrapRefreshInFlight = false;
const requiredNodeAgentVersion = "0.8.0";

const clientCatalog = {
  mihomo: { name: "Clash / Mihomo", platforms: "Windows / macOS / Android", action: "导入订阅" },
  loon: {
    name: "Loon 节点订阅",
    platforms: "iPhone / iPad / macOS · 保留现有规则",
    action: "下载节点订阅"
  },
  "egern-profile": {
    name: "Egern 完整配置",
    platforms: "iPhone / iPad · 含智能策略、分流与 DNS",
    action: "下载完整配置"
  },
  egern: {
    name: "Egern 节点订阅",
    platforms: "iPhone / iPad · 仅添加节点，保留现有规则",
    action: "下载节点订阅"
  },
  "sing-box": { name: "sing-box", platforms: "1.14+ · iOS / Android / Desktop", action: "下载配置" }
};
const universalClientFormats = Object.freeze(["mihomo", "loon", "egern-profile", "egern", "sing-box"]);

const accountSummary = { totalUsers: 0 };

const controlPlane = {
  currentAdmin: null,
  hosts: [],
  runtime: null,
  runtimePreview: null,
  installation: null,
  runtimeUpdate: null,
  protocolCatalog: [],
  deployments: [],
  backups: [],
  alerts: [],
  readiness: null,
  alertDelivery: null,
  admins: [],
  auditEvents: [],
  telemetry: { windowHours: 24, networkSeries: [] },
  access: null,
  certificate: { mode: null, email: "" },
  routingPolicy: { mode: "smart", unknownDomain: "resolve-geoip", rules: [] },
  routingRuleSets: null,
  portalProfile: null
};

const mcpAccess = { tokens: [], scopes: [], endpoint: "", issued: null, loading: false, creating: false, generation: 0 };

const scopeLabels = {
  all: "全部节点",
  tokyo: "东京",
  singapore: "新加坡",
  frankfurt: "法兰克福",
  losangeles: "洛杉矶"
};

const stateLabels = {
  active: { label: "启用", className: "good" },
  warning: { label: "临近配额", className: "warning" },
  disabled: { label: "已停用", className: "neutral" }
};

const hostDetails = {
  "东京核心": { region: "日本 · 东京", ip: "103.45.17.82", os: "Ubuntu 24.04", cpu: 34, memory: 48, protocols: "VLESS + Reality", port: "443", sync: "8 秒前" },
  "新加坡边缘": { region: "新加坡", ip: "18.141.202.73", os: "Debian 12", cpu: 51, memory: 63, protocols: "Hysteria2 + TUIC", port: "8443 / UDP", sync: "11 秒前" },
  "法兰克福": { region: "德国 · 法兰克福", ip: "3.71.186.44", os: "Ubuntu 24.04", cpu: 27, memory: 39, protocols: "VLESS + Trojan", port: "443 / 9443", sync: "9 秒前" },
  "洛杉矶入口": { region: "美国 · 洛杉矶", ip: "34.216.88.109", os: "Debian 12", cpu: 76, memory: 71, protocols: "VLESS + Reality", port: "443", sync: "16 秒前" }
};

const elements = {
  authScreen: document.querySelector("#admin-auth"),
  authForm: document.querySelector("#admin-login-form"),
  authError: document.querySelector("#admin-auth-error"),
  appShell: document.querySelector("#app-shell"),
  rail: document.querySelector("#rail"),
  profileMenu: document.querySelector("#profile-menu"),
  profileMenuTrigger: document.querySelector("#profile-menu-trigger"),
  menuToggle: document.querySelector("#menu-toggle"),
  mobileNav: document.querySelector(".mobile-nav"),
  indicator: document.querySelector(".nav-indicator"),
  userBody: document.querySelector("#user-table-body"),
  userCount: document.querySelector("#user-result-count"),
  userSearch: document.querySelector("#user-search"),
  hostBody: document.querySelector("#host-table-body"),
  drawer: document.querySelector("#detail-drawer"),
  drawerTitle: document.querySelector("#drawer-title"),
  drawerEyebrow: document.querySelector("#drawer-eyebrow"),
  drawerContent: document.querySelector("#drawer-content"),
  drawerClose: document.querySelector("#drawer-close"),
  drawerCancel: document.querySelector("#drawer-cancel"),
  drawerSave: document.querySelector("#drawer-save"),
  drawerScrim: document.querySelector("#drawer-scrim"),
  toast: document.querySelector("#toast"),
  toastTitle: document.querySelector("#toast-title"),
  toastMessage: document.querySelector("#toast-message")
};

let activeUserFilter = "all";
let toastTimer;
let lastFocusedElement;
let publishInProgress = false;
let currentPortalUserEmail = "";

function icon(name) {
  return `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value == null ? "" : String(value);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(body?.error?.message || `请求失败（${response.status}）`);
    error.code = body?.error?.code;
    error.status = response.status;
    throw error;
  }
  return body;
}

function scopeToLabel(scope) {
  if (scope.includes("all")) return "全部节点";
  return scope.map((region) => scopeLabels[region] || region).join(" + ");
}

function labelToScope(label) {
  if (label === "全部节点") return ["all"];
  return label.split(" + ").map((name) => Object.entries(scopeLabels).find(([, value]) => value === name)?.[0] || name);
}

function userCanUseHost(user, hostRegion, now = new Date()) {
  if (!["active", "warning"].includes(user.state)) return false;
  if (user.portalStatus !== "active") return false;
  if (user.used >= user.quota) return false;
  const expiresAt = new Date(`${user.expires}T23:59:59.999Z`);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt < now) return false;
  return (user.nodeScope || []).some((scope) => scope === "all" || scope === hostRegion);
}

function usageMeteringLabel(metering = {}) {
  return ({
    healthy: "采集中",
    error: "采集故障",
    stale: "数据中断",
    "awaiting-sample": "等待首个样本",
    unsupported: "能力缺失"
  })[metering.status] || "状态未知";
}

function usageMeteringDescription(metering = {}) {
  if (metering.status === "healthy") {
    return `真实上下行累计字节已入账${metering.lastSampleAt ? ` · 最近 ${escapeHtml(new Date(metering.lastSampleAt).toLocaleString("zh-CN"))}` : ""}。`;
  }
  if (metering.status === "error") {
    return `V2Ray Stats 采集或上报失败：${escapeHtml(metering.lastError || "未知错误")}`;
  }
  if (metering.status === "stale") {
    return `超过 2 分钟未收到真实计量样本${metering.lastSampleAt ? ` · 最近 ${escapeHtml(new Date(metering.lastSampleAt).toLocaleString("zh-CN"))}` : ""}。`;
  }
  if (metering.status === "awaiting-sample") {
    return "Runtime 已具备计量能力，正在等待首个真实样本。";
  }
  return "当前 Runtime 缺少 with_v2ray_api 构建标签，不会生成估算流量。";
}

function versionIsOlder(currentVersion, targetVersion) {
  const current = String(currentVersion || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  const target = String(targetVersion || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!current || !target) return false;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(target[index]) - Number(current[index]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function applyBootstrap(data) {
  const previousAdminId = controlPlane.currentAdmin?.id;
  users.splice(0, users.length, ...data.users.map((user) => ({
    id: user.id,
    name: user.name,
    initials: user.initials,
    email: user.email,
    portalStatus: user.portalStatus,
    state: user.state,
    used: user.usedGb,
    quota: user.quotaGb,
    nodeScope: user.nodeScope,
    expires: user.expiresAt,
    subscription: user.subscription
  })));
  accountSummary.totalUsers = users.length;
  controlPlane.currentAdmin = data.currentAdmin;
  controlPlane.hosts = data.hosts;
  controlPlane.runtime = data.runtime;
  controlPlane.runtimePreview = data.runtimePreview;
  controlPlane.installation = data.installation;
  controlPlane.runtimeUpdate = data.runtimeUpdate;
  controlPlane.protocolCatalog = data.protocolCatalog;
  controlPlane.deployments = data.deployments;
  controlPlane.backups = data.backups || [];
  controlPlane.alerts = data.alerts || [];
  controlPlane.alertDelivery = data.alertDelivery || null;
  controlPlane.admins = data.admins || [];
  controlPlane.auditEvents = data.auditEvents || [];
  controlPlane.telemetry = data.telemetry || { windowHours: 24, networkSeries: [] };
  controlPlane.access = data.access || null;
  controlPlane.certificate = data.certificate || { mode: null, email: "" };
  controlPlane.routingRuleSets = data.routingRuleSets || null;
  controlPlane.routingPolicy = data.routingPolicy || {
    mode: "smart",
    unknownDomain: "resolve-geoip",
    rules: []
  };
  const rollbackButton = document.querySelector("#rollback-config");
  const rollbackTarget = data.deployments.find((deployment) => deployment.status === "superseded");
  if (rollbackButton) {
    rollbackButton.disabled = !rollbackTarget;
    rollbackButton.dataset.deploymentId = rollbackTarget?.id || "";
    rollbackButton.title = rollbackTarget ? `回滚到 ${rollbackTarget.version}` : "没有可回滚的历史版本";
  }
  const profileButton = document.querySelector(".profile-button");
  if (profileButton) {
    profileButton.querySelector(".avatar").textContent = data.currentAdmin.username.slice(0, 2).toUpperCase();
    profileButton.querySelector("strong").textContent = data.currentAdmin.username;
    profileButton.querySelector("small").textContent = {
      owner: "Owner",
      operator: "运维管理员",
      support: "客服管理员",
      auditor: "审计员"
    }[data.currentAdmin.role] || "管理员";
  }
  document.body.dataset.adminRole = data.currentAdmin.role || "owner";
  document.querySelectorAll("[data-owner-only]").forEach((element) => {
    element.hidden = data.currentAdmin.role !== "owner";
  });
  if (data.currentAdmin.role !== "owner" || (previousAdminId && previousAdminId !== data.currentAdmin.id)) {
    clearMcpAccess();
    if (!document.querySelector('[data-system-panel="mcp"]').hidden) selectWorkspaceTab("system", "hosts");
  }
  renderUsers();
  renderRuntime();
  renderRoutingPolicy();
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");
  applyBootstrap(data);
  return data;
}

function renderRuntime() {
  const runtime = controlPlane.runtime;
  if (!runtime) return;
  const railStatus = document.querySelector(".rail-status");
  const activeDeployment = controlPlane.deployments.find((deployment) => deployment.status === "active");
  const deploymentVersion = activeDeployment?.version || "尚未发布";
  const healthy = runtime.state === "running";
  railStatus.querySelector("strong").textContent = healthy
    ? "Runtime 运行中"
    : runtime.state === "staged"
      ? "Runtime 已暂存"
      : "Runtime 待配置";
  railStatus.querySelector("small").textContent = runtime.runtimeVersion
    ? `sing-box ${runtime.runtimeVersion}`
    : `${runtime.mode} · ${runtime.state}`;
  document.querySelectorAll(".release-version").forEach((element) => {
    element.textContent = deploymentVersion;
  });
  const listenPort = document.querySelector("#managed-listen-port");
  if (listenPort && controlPlane.runtimePreview) listenPort.textContent = controlPlane.runtimePreview.listenPort;
  renderHosts();
  renderConfigPreview();
  renderDashboard();
  renderSystemRuntime();
  renderSystem();
}

const routingModeCopy = {
  smart: {
    title: "智能分流",
    description: "内网和国内流量直接访问，AI 与境外流量走代理；未知域名解析真实 IP 后再判断。"
  },
  "global-proxy": {
    title: "全局代理",
    description: "除内网和显式直连规则外，全部流量交给 RayLink 智能代理组。"
  },
  direct: {
    title: "全部直连",
    description: "默认直连，仍遵从自定义代理、AI 和拦截例外，适合临时排障。"
  }
};

const routingActionLabels = {
  direct: "直连",
  proxy: "代理",
  ai: "AI 代理",
  block: "拦截"
};

const routingMatchLabels = {
  domain: "完整域名",
  domain_suffix: "域名后缀",
  ip: "单个 IP",
  ip_cidr: "IP 网段"
};

function renderRoutingPolicy() {
  const policy = controlPlane.routingPolicy;
  const mode = routingModeCopy[policy.mode] || routingModeCopy.smart;
  document.querySelectorAll('#routing-mode-form input[name="mode"]').forEach((input) => {
    input.checked = input.value === policy.mode;
  });
  setText("#routing-mode-title", mode.title);
  setText("#routing-mode-description", mode.description);
  setText("#routing-rule-count", policy.rules.length);
  setText("#routing-rules-badge", policy.rules.length);
  const ruleSets = controlPlane.routingRuleSets;
  setText("#routing-rule-set-version", ruleSets?.version || "随包基线");
  setText("#routing-bundled-version", ruleSets?.bundledVersion || "随应用更新");
  setText("#routing-rule-set-status", ruleSets?.degraded
    ? `更新降级：${ruleSets.lastError || "使用最近有效基线"}`
    : ruleSets?.available ? "完整规则可用 · 校验通过" : "导出使用完整随包规则");
  const list = document.querySelector("#routing-rule-list");
  if (!list) return;
  if (!policy.rules.length) {
    list.innerHTML = '<div class="routing-rules-empty">没有自定义规则。智能模式仍会使用内置 AI、国内域名和国内 IP 规则。</div>';
    return;
  }
  list.innerHTML = policy.rules.map((rule, index) => `
    <div class="rule-row">
      <span class="rule-order">${index + 1}</span>
      <div>
        <strong>${escapeHtml(routingMatchLabels[rule.match] || rule.match)} · ${escapeHtml(rule.value)}</strong>
        <small>优先级 ${rule.priority} · DNS ${escapeHtml(rule.dns)}${rule.note ? ` · ${escapeHtml(rule.note)}` : ""}</small>
      </div>
      <div class="routing-rule-actions">
        <span class="tag">${escapeHtml(routingActionLabels[rule.action] || rule.action)}</span>
        <button class="icon-button" type="button" data-routing-rule-delete="${escapeHtml(rule.id)}" aria-label="删除规则">${icon("x")}</button>
      </div>
    </div>
  `).join("");
}

async function persistRoutingPolicy(nextPolicy, successMessage) {
  const saved = await api("/api/settings/routing", {
    method: "PATCH",
    body: JSON.stringify(nextPolicy)
  });
  controlPlane.routingPolicy = saved;
  renderRoutingPolicy();
  showToast("策略已保存", successMessage);
  return saved;
}

async function saveRoutingMode(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const mode = new FormData(form).get("mode");
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await persistRoutingPolicy(
      { ...controlPlane.routingPolicy, mode },
      "新订阅和客户端配置会立即使用统一路由模式。"
    );
  } catch (error) {
    showToast("保存失败", error.message);
  } finally {
    button.disabled = false;
  }
}

async function addRoutingRule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  const rule = {
    id: `rule-${Date.now().toString(36)}`,
    match: fields.get("match"),
    value: String(fields.get("value") || "").trim(),
    action: fields.get("action"),
    dns: fields.get("dns"),
    priority: Number(fields.get("priority")),
    enabled: true,
    note: String(fields.get("note") || "").trim()
  };
  button.disabled = true;
  try {
    await persistRoutingPolicy(
      {
        ...controlPlane.routingPolicy,
        rules: [...controlPlane.routingPolicy.rules, rule]
      },
      "自定义规则已写入所有完整订阅格式。"
    );
    form.reset();
    form.elements.priority.value = "100";
  } catch (error) {
    showToast("规则未保存", error.message);
  } finally {
    button.disabled = false;
  }
}

async function diagnoseRouting(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const result = document.querySelector("#routing-diagnose-result");
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  result.innerHTML = "<span>正在解析域名并匹配规则集…</span>";
  try {
    const diagnostic = await api("/api/routing/diagnose", {
      method: "POST",
      body: JSON.stringify({ domain: form.elements.domain.value.trim() })
    });
    const addressText = diagnostic.addresses.length
      ? diagnostic.addresses.map((entry) => entry.address).join("、")
      : "无需解析";
    result.innerHTML = `
      <div><small>推断出口</small><strong>${escapeHtml(diagnostic.outbound || "混合结果，需客户端确认")}</strong></div>
      <div><small>命中来源</small><strong>${escapeHtml(diagnostic.source)}</strong></div>
      <div><small>策略 DNS</small><strong>${escapeHtml(diagnostic.dns)}</strong></div>
      <div><small>证据来源</small><strong>${diagnostic.evidence?.kind === "control-plane-dns" ? "主控系统 DNS" : "规则推断"}</strong></div>
      <div class="full"><small>解析地址</small><strong>${escapeHtml(addressText)}</strong></div>
      <p>${escapeHtml(diagnostic.explanation)} · ${escapeHtml(new Date(diagnostic.checkedAt).toLocaleString("zh-CN"))}</p>
      ${(diagnostic.warnings || []).map((warning) => `<p>${escapeHtml(warning)}</p>`).join("")}
    `;
  } catch (error) {
    result.innerHTML = `<span class="danger-text">${escapeHtml(error.message)}</span>`;
  } finally {
    button.disabled = false;
  }
}

function renderDashboard() {
  const runtime = controlPlane.runtime || { state: "not-configured", mode: "dry-run" };
  const hosts = controlPlane.hosts;
  const host = hosts.find((candidate) => candidate.id === "local") || hosts[0];
  const latestAttempt = controlPlane.deployments[0];
  const activeDeployment = controlPlane.deployments.find((deployment) => deployment.status === "active");
  const ready = runtime.state === "running";
  const readyHosts = hosts.filter((candidate) => {
    if (candidate.id === "local") return ready;
    return candidate.status === "online"
      && candidate.telemetry?.serviceStatus === "running"
      && candidate.telemetry?.updatedAt
      && Date.now() - new Date(candidate.telemetry.updatedAt).getTime() <= 30_000;
  });
  const activeUsers = users.filter((user) => ["active", "warning"].includes(user.state)).length;
  const update = controlPlane.runtimeUpdate;
  const upgradableHosts = update?.latestVersion
    ? hosts.filter((candidate) => {
      const currentVersion = candidate.id === "local"
        ? controlPlane.installation?.version
        : candidate.runtimeVersion;
      const meteringReady = candidate.id === "local"
        ? controlPlane.installation?.tags?.includes("with_v2ray_api")
        : candidate.usageMetering?.supported;
      return versionIsOlder(currentVersion, update.latestVersion)
        || (currentVersion === update.latestVersion && !meteringReady);
    })
    : [];
  setText("#dashboard-runtime-heading", hosts.length
    ? `${readyHosts.length}/${hosts.length} 个 Runtime 可用`
    : "尚未添加 Runtime");
  setText("#dashboard-runtime-copy", readyHosts.length
    ? `控制面正在管理 ${hosts.length} 台主机；节点指标来自本机采样与 RayLink Node 心跳。`
    : hosts.length
      ? `控制面正在管理 ${hosts.length} 台主机，但目前没有实际运行的 Runtime。`
      : "完成主机配置后，在“配置发布”中生成并校验第一份受管配置。");
  const runtimeCount = document.querySelector("#dashboard-runtime-count");
  if (runtimeCount) runtimeCount.innerHTML = `${readyHosts.length}<small>/ ${hosts.length}</small>`;
  setText("#dashboard-runtime-mode", `${runtime.mode} · ${runtime.state}`);
  setText("#dashboard-eligible-users", activeDeployment?.eligibleUsers ?? controlPlane.runtimePreview?.eligibleUsers ?? 0);
  setText("#dashboard-user-count", users.length);
  setText("#dashboard-active-users", `${activeUsers} 个账号启用`);
  setText("#dashboard-deployment-count", controlPlane.deployments.length);
  setText("#dashboard-latest-version", activeDeployment?.version || "尚未发布");
  setText("#dashboard-host-name", `${hosts.length} 台主机`);
  const updateNotice = document.querySelector("#runtime-update-notice");
  if (updateNotice) {
    updateNotice.hidden = update?.compatible === false || upgradableHosts.length === 0;
    setText("#runtime-update-notice-title", `sing-box ${update?.latestVersion || ""} 可升级`);
    setText(
      "#runtime-update-notice-copy",
      `${upgradableHosts.length} 台 Runtime 可升级；系统会先备份并校验，失败自动恢复旧版本。`
    );
  }
  const alertNotice = document.querySelector("#operational-alert-notice");
  const firstAlert = controlPlane.alerts[0];
  if (alertNotice) {
    alertNotice.hidden = !firstAlert;
    setText(
      "#operational-alert-title",
      firstAlert
        ? `${firstAlert.title}${controlPlane.alerts.length > 1 ? `（另有 ${controlPlane.alerts.length - 1} 项）` : ""}`
        : "当前没有运行告警"
    );
    setText("#operational-alert-copy", firstAlert?.message || "节点、发布、协议、计量与备份状态正常。");
  }
  const notificationDot = document.querySelector("#notification-button .notification-dot");
  if (notificationDot) notificationDot.hidden = controlPlane.alerts.length === 0;
  renderDashboardNodes({ hosts, runtime, ready });
  setText("#dashboard-deployment-version", activeDeployment?.version || "尚未发布");
  const deploymentStatus = document.querySelector("#dashboard-deployment-status");
  if (deploymentStatus) {
    const rollout = activeDeployment?.rolloutStatus;
    const rolloutPresentation = rollout === "complete"
      ? { className: "good", label: "全部节点已应用" }
      : rollout === "failed"
        ? { className: "danger", label: "节点发布失败" }
        : activeDeployment
          ? { className: "warning", label: "节点应用中" }
          : { className: "neutral", label: "无记录" };
    deploymentStatus.className = `status-badge ${rolloutPresentation.className}`;
    deploymentStatus.innerHTML = `<i></i>${rolloutPresentation.label}`;
  }
  setText("#dashboard-deployment-users", activeDeployment?.eligibleUsers || 0);
  setText("#dashboard-deployment-time", activeDeployment?.publishedAt
    ? `${activeDeployment.publisherUsername || "管理员"} · ${new Date(activeDeployment.publishedAt).toLocaleString("zh-CN")}`
    : "—");
  const appliedTargets = activeDeployment?.targets?.filter(
    (target) => target.status === "applied"
  ).length || 0;
  const targetCount = activeDeployment?.targets?.length || 0;
  setText("#dashboard-deployment-validation", latestAttempt?.status === "failed"
    ? `最近一次尝试失败：${latestAttempt.error}`
    : activeDeployment
      ? `${appliedTargets}/${targetCount} 个目标已应用`
      : runtime.runtimeVersion ? `sing-box ${runtime.runtimeVersion}` : runtime.mode);
  const deploymentTrail = document.querySelector(".deployment-panel .change-log");
  if (deploymentTrail && activeDeployment?.targets?.length) {
    deploymentTrail.innerHTML = activeDeployment.targets.map((target) => {
      const status = {
        applied: "已应用",
        pending: "等待节点",
        deploying: "正在部署",
        failed: "失败",
        "not-queued": "未排队",
        superseded: "已替换"
      }[target.status] || target.status;
      return `<span>${escapeHtml(target.name)} · ${escapeHtml(status)}</span>`;
    }).join("");
  }
  renderNetworkTrend();
  const policyStatus = activeDeployment ? `策略 ${activeDeployment.version} 已生效` : "尚未发布账号策略";
  const policyMeta = activeDeployment?.publishedAt
    ? `${activeDeployment.publisherUsername || "管理员"} · ${new Date(activeDeployment.publishedAt).toLocaleString("zh-CN")}`
    : "修改后需要重新发布配置";
  setText("#user-policy-status", policyStatus);
  setText("#user-policy-meta", policyMeta);
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}

function formatBitRate(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mbps`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} Kbps`;
  return `${Math.round(value)} bps`;
}

function hostStatusView(host, runtime, localReady) {
  if (host.id === "local") {
    return localReady
      ? { label: "运行中", className: "good" }
      : runtime.state === "staged"
        ? { label: "已暂存", className: "neutral" }
        : { label: runtime.state === "not-configured" ? "待发布" : "异常", className: "warning" };
  }
  if (host.deploymentSync?.status === "revocation-pending") {
    return { label: "撤权待应用", className: "danger" };
  }
  if (host.deploymentSync?.status === "pending") {
    return { label: "配置待应用", className: "warning" };
  }
  if (host.status === "offline") return { label: "离线", className: "danger" };
  if (host.status === "pending") return { label: "等待接入", className: "neutral" };
  if (host.agentVersion !== requiredNodeAgentVersion) {
    return { label: "Node 待升级", className: "warning" };
  }
  if (!host.telemetry?.updatedAt || Date.now() - new Date(host.telemetry.updatedAt).getTime() > 30_000) {
    return { label: "状态过期", className: "warning" };
  }
  if (host.telemetry.serviceStatus === "unknown") return { label: "待上报", className: "neutral" };
  if (host.status === "degraded" || ["stopped", "failed"].includes(host.telemetry?.serviceStatus)) {
    return { label: "服务异常", className: "warning" };
  }
  return { label: "运行中", className: "good" };
}

function renderDashboardNodes({ hosts, runtime, ready }) {
  const compactList = document.querySelector("#dashboard-node-list");
  const healthGrid = document.querySelector("#dashboard-node-health-grid");
  if (!compactList || !healthGrid) return;
  if (!hosts.length) {
    const empty = '<div class="empty-state">尚未添加受管主机</div>';
    compactList.innerHTML = empty;
    healthGrid.innerHTML = empty;
    return;
  }
  compactList.innerHTML = hosts.map((host) => {
    const telemetry = host.telemetry || {};
    const status = hostStatusView(host, runtime, ready);
    const cpu = Number.isFinite(telemetry.cpuPercent) ? telemetry.cpuPercent : 0;
    return `
      <button class="node-row" data-open-host="${escapeHtml(host.id)}">
        <span class="node-pulse ${status.className === "good" ? "" : "warning"}"></span>
        <span class="node-name"><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}</small></span>
        <span class="node-load" title="CPU ${cpu.toFixed(1)}%"><i style="--load:${cpu}%"></i></span>
        <span class="latency ${status.className === "good" ? "" : "warning"}">${escapeHtml(status.label)}</span>
      </button>`;
  }).join("");
  healthGrid.innerHTML = hosts.map((host) => {
    const telemetry = host.telemetry || {};
    const status = hostStatusView(host, runtime, ready);
    const runtimeVersion = host.runtimeVersion
      || (host.id === "local" ? runtime.runtimeVersion : null)
      || "版本待上报";
    const memoryPercent = Number.isFinite(telemetry.memoryUsedBytes) && Number.isFinite(telemetry.memoryTotalBytes)
      ? (telemetry.memoryUsedBytes / telemetry.memoryTotalBytes) * 100
      : null;
    const diskPercent = Number.isFinite(telemetry.diskUsedBytes) && Number.isFinite(telemetry.diskTotalBytes)
      ? (telemetry.diskUsedBytes / telemetry.diskTotalBytes) * 100
      : null;
    const networkTotal = (telemetry.networkRxBps || 0) + (telemetry.networkTxBps || 0);
    return `
      <article class="node-health-card">
        <div class="node-health-heading">
          <button class="identity-link" data-open-host="${escapeHtml(host.id)}"><span class="flag">SB</span><span><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}</small></span></button>
          <span class="status-badge ${status.className}"><i></i>${escapeHtml(status.label)}</span>
        </div>
        <div class="node-health-metrics">
          <span><small>CPU</small><strong>${Number.isFinite(telemetry.cpuPercent) ? `${telemetry.cpuPercent.toFixed(1)}%` : "—"}</strong><i style="--load:${telemetry.cpuPercent || 0}%"></i></span>
          <span><small>内存</small><strong>${memoryPercent === null ? "—" : `${memoryPercent.toFixed(1)}%`}</strong><em>${formatBytes(telemetry.memoryUsedBytes)} / ${formatBytes(telemetry.memoryTotalBytes)}</em></span>
          <span><small>磁盘</small><strong>${diskPercent === null ? "—" : `${diskPercent.toFixed(1)}%`}</strong><em>${formatBytes(telemetry.diskUsedBytes)} / ${formatBytes(telemetry.diskTotalBytes)}</em></span>
          <span><small>网络</small><strong>${formatBitRate(networkTotal)}</strong><em>↓ ${formatBitRate(telemetry.networkRxBps)} · ↑ ${formatBitRate(telemetry.networkTxBps)}</em></span>
          <span><small>sing-box 服务</small><strong>${escapeHtml({ running: "运行中", staged: "已暂存", stopped: "已停止", failed: "异常", unknown: "待上报" }[telemetry.serviceStatus] || "待上报")}</strong><em>${escapeHtml(runtimeVersion)}</em></span>
        </div>
      </article>`;
  }).join("");
}

function renderNetworkTrend() {
  const downloadLine = document.querySelector("#dashboard-download-line");
  const uploadLine = document.querySelector("#dashboard-upload-line");
  const downloadArea = document.querySelector("#dashboard-download-area");
  if (!downloadLine || !uploadLine || !downloadArea) return;

  const sourceSeries = controlPlane.telemetry?.networkSeries || [];
  const plottedSeries = sourceSeries.slice(-288);
  const download = plottedSeries.length
    ? plottedSeries.map((point) => Number(point.downloadBps || 0) / 1_000_000)
    : [0, 0];
  const upload = plottedSeries.length
    ? plottedSeries.map((point) => Number(point.uploadBps || 0) / 1_000_000)
    : [0, 0];
  const peak = Math.max(...download, ...upload, 0);
  const axisMax = Math.max(1, Math.ceil(peak));
  const downloadPath = trafficPath(download, axisMax);
  const uploadPath = trafficPath(upload, axisMax);

  downloadLine.setAttribute("d", downloadPath);
  uploadLine.setAttribute("d", uploadPath);
  downloadArea.setAttribute("d", `${downloadPath} L760 230 L0 230 Z`);

  const currentDownloadBps = Number(plottedSeries.at(-1)?.downloadBps || 0);
  const currentUploadBps = Number(plottedSeries.at(-1)?.uploadBps || 0);
  setText("#dashboard-download-total", formatBitRate(currentDownloadBps));
  setText("#dashboard-upload-total", formatBitRate(currentUploadBps));
  setText("#dashboard-traffic-peak", `${peak.toFixed(1)} Mbps`);
  setText(
    "#dashboard-traffic-current",
    `${((download.at(-1) || 0) + (upload.at(-1) || 0)).toFixed(1)} Mbps`
  );
  setText("#dashboard-trend-updated", plottedSeries.length
    ? `最近采样 ${new Date(plottedSeries.at(-1).recordedAt).toLocaleString("zh-CN")}`
    : "等待首次采样");
  const telemetryStatus = document.querySelector("#dashboard-telemetry-status");
  if (telemetryStatus) {
    telemetryStatus.className = `status-badge ${plottedSeries.length ? "good" : "neutral"}`;
    telemetryStatus.innerHTML = `<i></i>${plottedSeries.length ? "真实遥测" : "等待遥测"}`;
  }
  setText(
    "#dashboard-chart-description",
    plottedSeries.length
      ? `主机网络遥测：当前下行 ${formatBitRate(currentDownloadBps)}，`
        + `当前上行 ${formatBitRate(currentUploadBps)}，峰值 ${peak.toFixed(1)} Mbps。`
      : "尚未收到主机网络遥测。"
  );

  const chartY = document.querySelector("#dashboard-chart-y");
  if (chartY) {
    chartY.innerHTML = [
      axisMax,
      axisMax * (2 / 3),
      axisMax * (1 / 3),
      0
    ].map((value) => `<span>${value.toFixed(value % 1 === 0 ? 0 : 1)}</span>`).join("");
  }
  const chartX = document.querySelector("#dashboard-chart-x");
  if (chartX) {
    const lastPoint = plottedSeries.at(-1)?.recordedAt ? new Date(plottedSeries.at(-1).recordedAt) : new Date();
    const firstPoint = plottedSeries.length > 1 && plottedSeries[0]?.recordedAt
      ? new Date(plottedSeries[0].recordedAt)
      : new Date(lastPoint.getTime() - (controlPlane.telemetry?.windowHours || 24) * 60 * 60 * 1000);
    const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    chartX.innerHTML = [0, 0.25, 0.5, 0.75, 1].map((ratio, index, ticks) => {
      if (index === ticks.length - 1) return "<span>最新</span>";
      const tick = new Date(firstPoint.getTime() + (lastPoint.getTime() - firstPoint.getTime()) * ratio);
      return `<span>${timeFormatter.format(tick)}</span>`;
    }).join("");
  }
}

function trafficPath(values, maxValue) {
  const width = 760;
  const top = 20;
  const bottom = 209;
  return values.map((value, index) => {
    const x = index * (width / Math.max(1, values.length - 1));
    const y = bottom - (value / maxValue) * (bottom - top);
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function topologyPositions(count) {
  if (count <= 0) return [];
  if (count === 1) return [{ x: 760, y: 160 }];
  const radiusX = count > 8 ? 390 : 360;
  const radiusY = count > 8 ? 126 : 116;
  const startAngle = count === 2 ? 0 : -Math.PI / 2;
  return Array.from({ length: count }, (_, index) => {
    const angle = startAngle + (Math.PI * 2 * index) / count;
    return {
      x: Math.round(500 + Math.cos(angle) * radiusX),
      y: Math.round(160 + Math.sin(angle) * radiusY)
    };
  });
}

function topologyHostState(host, runtime) {
  if (host.id === "local" || host.kind !== "remote") {
    const online = ["running", "staged"].includes(runtime.state);
    return {
      className: online ? "online" : "offline",
      label: online ? "运行中" : "待发布",
      online
    };
  }
  if (host.status === "online") {
    const runtimeHealthy = !host.telemetry?.serviceStatus
      || host.telemetry.serviceStatus === "running";
    return {
      className: runtimeHealthy ? "online" : "warning",
      label: runtimeHealthy ? "在线" : "Runtime 异常",
      online: runtimeHealthy
    };
  }
  if (host.status === "pending") {
    return { className: "pending", label: "等待接入", online: false };
  }
  if (host.status === "degraded") {
    return { className: "warning", label: "发布失败", online: false };
  }
  return { className: "offline", label: "离线", online: false };
}

function renderHostTopology(hosts, runtime) {
  const topology = document.querySelector("#host-topology");
  if (!topology) return;
  const panelX = 500;
  const panelY = 160;
  const positions = topologyPositions(hosts.length);
  const hostStates = hosts.map((host) => topologyHostState(host, runtime));
  const links = hosts.map((host, index) => {
    const position = positions[index];
    const state = hostStates[index];
    return `
      <line
        class="topology-link ${state.className}"
        data-topology-link="${escapeHtml(host.id)}"
        x1="${panelX}"
        y1="${panelY}"
        x2="${position.x}"
        y2="${position.y}"
        vector-effect="non-scaling-stroke"
      />`;
  }).join("");
  const nodes = hosts.map((host, index) => {
    const position = positions[index];
    const state = hostStates[index];
    const type = host.id === "local" || host.kind !== "remote"
      ? "本机 Runtime"
      : "RayLink Node";
    return `
      <button
        type="button"
        class="map-node topology-node ${state.className}"
        data-topology-host="${escapeHtml(host.id)}"
        data-open-host="${escapeHtml(host.id)}"
        style="--topology-x:${(position.x / 10).toFixed(1)}%;--topology-y:${(position.y / 3.2).toFixed(1)}%"
        aria-label="${escapeHtml(`${host.name}，${state.label}`)}"
      >
        <span class="topology-node-mark"><i></i>SB</span>
        <span class="topology-node-copy">
          <strong>${escapeHtml(host.name)}</strong>
          <small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}</small>
          <em><i></i>${escapeHtml(type)} · ${escapeHtml(state.label)}</em>
        </span>
      </button>`;
  }).join("");
  const panelHost = location.hostname || "Control Plane";
  topology.innerHTML = `
    <svg class="topology-links" viewBox="0 0 1000 320" preserveAspectRatio="none" aria-hidden="true">
      ${links}
    </svg>
    <div class="map-origin topology-panel">
      <span class="topology-panel-mark"><img src="/assets/brand/raylink-mark.svg?v=20260726" alt=""></span>
      <span><strong>RayLink Panel</strong><small>${escapeHtml(panelHost)}</small></span>
      <em><i></i>控制面在线</em>
    </div>
    ${nodes || '<span class="topology-empty">尚未添加 Runtime Host</span>'}
  `;
  const healthyCount = hostStates.filter((state) => state.online).length;
  const status = document.querySelector("#host-map-status");
  status.className = healthyCount === hosts.length && hosts.length
    ? "online"
    : healthyCount > 0
      ? "partial"
      : "offline";
  status.innerHTML = `<i></i>${healthyCount}/${hosts.length} 个 Host 在线`;
}

function renderHosts() {
  if (!elements.hostBody) return;
  const hosts = controlPlane.hosts;
  const runtime = controlPlane.runtime || { state: "unknown", mode: "dry-run" };
  renderHostTopology(hosts, runtime);
  if (!hosts.length) {
    elements.hostBody.innerHTML = '<tr><td colspan="7"><div class="empty-state">尚未配置 Runtime 主机</div></td></tr>';
    return;
  }
  elements.hostBody.innerHTML = hosts.map((host) => {
    const protocolLabels = (host.protocols || [])
      .filter((profile) => profile.enabled)
      .map((profile) => {
        const activation = host.protocolActivations?.find((item) => item.type === profile.type);
        return {
          name: controlPlane.protocolCatalog.find((item) => item.type === profile.type)?.name || profile.type,
          connection: protocolHealth.present(activation)
        };
      });
    const isLocal = host.kind !== "remote";
    const healthy = isLocal
      ? runtime.state === "running"
      : host.status === "online"
        && host.agentVersion === requiredNodeAgentVersion
        && host.telemetry?.serviceStatus === "running";
    const status = isLocal
      ? (healthy ? "运行中" : runtime.state === "staged" ? "已暂存" : "待配置")
      : host.deploymentSync?.status === "revocation-pending"
        ? "撤权待应用"
        : host.runtimeUpgrade?.pending
          ? "Runtime 升级中"
        : host.runtimeUpgrade?.status === "failed"
          ? host.runtimeUpgrade.rolledBack && host.runtimeUpgrade.packageMetadataRestored !== false
            ? "升级失败·已回滚"
            : "升级失败·需检查"
        : host.deploymentSync?.status === "pending"
          ? "配置待应用"
      : host.agentVersion && host.agentVersion !== requiredNodeAgentVersion
        ? "Node 待升级"
        : ({ pending: "等待接入", online: "在线", degraded: "发布失败" }[host.status] || "离线");
    const statusClass = host.deploymentSync?.status === "revocation-pending"
      ? "danger"
      : host.runtimeUpgrade?.status === "failed"
        ? host.runtimeUpgrade.rolledBack && host.runtimeUpgrade.packageMetadataRestored !== false
          ? "warning"
          : "danger"
      : healthy && !host.runtimeUpgrade?.pending
        ? "good"
        : host.status === "degraded" || host.deploymentSync?.status === "pending" || host.runtimeUpgrade?.pending
          ? "warning"
          : "neutral";
    const lastSeen = host.lastSeenAt
      ? new Intl.DateTimeFormat("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit"
        }).format(new Date(host.lastSeenAt))
      : "尚无心跳";
    return `
    <tr>
      <td><button class="identity-link" data-open-host="${escapeHtml(host.id)}"><span class="flag">SB</span><span><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}</small></span></button></td>
      <td><span class="status-badge ${statusClass}"><i></i>${status}</span></td>
      <td>${protocolLabels.length
        ? `<div class="host-protocol-tags" aria-label="已启用 ${protocolLabels.length} 个入口协议">${protocolLabels.map(({ name, connection }) => `<span class="tag protocol-latency-tag"><span>${escapeHtml(name)}</span><em class="protocol-latency-value ${connection.className}" title="${escapeHtml(connection.title)}">${escapeHtml(connection.summary)}</em></span>`).join("")}</div>`
        : '<span class="tag">尚未启用</span>'}</td>
      <td>${isLocal ? "控制面本机" : "RayLink Node"}</td>
      <td>${escapeHtml(isLocal ? runtime.platform || "local" : [host.platform, host.architecture].filter(Boolean).join(" / ") || "等待上报")}</td>
      <td><strong>${escapeHtml(isLocal ? runtime.runtimeVersion || runtime.mode : lastSeen)}</strong><small>${escapeHtml(isLocal ? runtime.state : host.runtimeVersion || host.agentVersion || "等待注册")}</small></td>
      <td><button class="icon-button small" aria-label="编辑${escapeHtml(host.name)}" data-open-host="${escapeHtml(host.id)}">${icon("more")}</button></td>
    </tr>`;
  }).join("");
  const host = hosts.find((item) => item.id === "local") || hosts[0];
  const managedTargetName = document.querySelector("#managed-target-name");
  if (managedTargetName) managedTargetName.textContent = host.name;
  document.querySelectorAll('.nav-item[data-view-target="system"] .nav-count').forEach((count) => {
    count.textContent = controlPlane.hosts.length;
  });
}

function renderConfigPreview() {
  const preview = document.querySelector("#managed-config-preview");
  if (!preview) return;
  const localProtocols = controlPlane.hosts.find((host) => host.id === "local")?.protocols || [];
  const inbounds = localProtocols.filter((profile) => profile.enabled).map((profile) => ({
    type: profile.type,
    tag: profile.type === "shadowsocks" ? "managed-shadowsocks" : `raylink-${profile.type}`,
    ...(profile.port ? { listen_port: profile.port } : {}),
    users: "$eligible_users"
  }));
  preview.textContent = JSON.stringify({
    log: { level: "info", timestamp: true },
    inbounds,
    outbounds: [{ type: "direct", tag: "direct" }],
    route: { final: "direct" }
  }, null, 2);
  const lineNumbers = preview.closest(".editor-body")?.querySelector(".line-numbers");
  if (lineNumbers) {
    lineNumbers.innerHTML = preview.textContent.split("\n").map((_, index) => `<li>${index + 1}</li>`).join("");
  }
  document.querySelector(".change-summary .add + strong").textContent = String(inbounds.length);
  const systemPreview = document.querySelector("#system-config-preview");
  if (systemPreview) systemPreview.textContent = preview.textContent;
}

function renderSystemRuntime() {
  const runtime = controlPlane.runtime || { state: "unknown", mode: "dry-run" };
  const installation = controlPlane.installation || { installed: false, version: null };
  const activeDeployment = controlPlane.deployments.find((deployment) => deployment.status === "active");
  const latestDeployment = controlPlane.deployments[0];
  setText("#system-runtime-state", runtime.state === "running" ? "运行中"
    : runtime.state === "staged" ? "已暂存 · 未运行" : "未确认运行");
  setText("#system-config-state", activeDeployment?.version || "尚未发布");
  setText(
    "#system-validation-state",
    latestDeployment?.status === "failed"
      ? "最近一次失败"
      : activeDeployment?.rolloutStatus === "complete"
        ? "全部目标已应用"
        : activeDeployment
          ? "节点应用中"
          : "尚无记录"
  );
  document.querySelectorAll(".release-version").forEach((element) => {
    element.textContent = activeDeployment?.version || "尚未发布";
  });
  const releaseBadge = document.querySelector(".system-release-panel .release-header .status-badge");
  if (releaseBadge) {
    const presentation = latestDeployment?.status === "failed"
      ? { className: "danger", label: "最近发布失败" }
      : activeDeployment?.rolloutStatus === "failed"
        ? { className: "danger", label: "部分目标失败" }
        : activeDeployment?.rolloutStatus === "complete"
          ? { className: "good", label: "已生效" }
          : activeDeployment
            ? { className: "warning", label: "应用中" }
            : { className: "neutral", label: "尚未发布" };
    releaseBadge.className = `status-badge ${presentation.className}`;
    releaseBadge.innerHTML = `<i></i>${presentation.label}`;
  }
  const facts = document.querySelector("#system-runtime-facts");
  if (facts) {
    facts.innerHTML = `
      <span><small>状态</small><strong>${escapeHtml(runtime.state || "unknown")}</strong></span>
      <span><small>运行模式</small><strong>${escapeHtml(runtime.mode || "unknown")}</strong></span>
      <span><small>sing-box</small><strong>${escapeHtml(runtime.runtimeVersion || installation.version || "未检测")}</strong></span>
      <span><small>配置路径</small><strong>${escapeHtml(runtime.configPath || "尚未生成")}</strong></span>`;
  }
  const log = document.querySelector("#system-deployment-log");
  if (log) {
    const entries = controlPlane.deployments.slice(0, 6).map((deployment) => {
      const time = deployment.publishedAt || deployment.createdAt;
      const status = deployment.rolloutStatus || deployment.status;
      const targets = deployment.targets?.length
        ? ` · ${deployment.targets.filter((target) => target.status === "applied").length}/${deployment.targets.length} 目标`
        : "";
      return `<span><time>${time ? new Date(time).toLocaleString("zh-CN") : "—"}</time> ${escapeHtml(deployment.version)} · ${escapeHtml(status)}${targets}</span>`;
    });
    log.innerHTML = entries.length
      ? entries.join("")
      : "<span>RayLink control plane ready.</span><span>等待首次发布事件…</span>";
  }
}

function renderSystem() {
  const installation = controlPlane.installation || { installed: false, version: null, platform: "unknown", architecture: null };
  const update = controlPlane.runtimeUpdate;
  const version = document.querySelector("#system-version");
  const build = document.querySelector("#system-build");
  const updateState = document.querySelector("#system-update-state");
  const upgradeButton = document.querySelector("#upgrade-local-runtime");
  if (version) version.textContent = installation.installed
    ? `sing-box ${installation.version || ""}`
    : "sing-box 未安装";
  if (build) build.textContent = installation.installed
    ? `${installation.platform} / ${installation.architecture || "unknown"} · ${installation.tags?.length || 0} 个 build tags`
    : "可在服务工作区执行一键安装。";
  if (updateState) {
    updateState.textContent = update?.status === "error"
      ? `检查失败：${update.error || "无法连接官方发布源"}`
      : update?.approvalNotice
        ? `${update.approvalNotice}。${update.updateAvailable ? `可安装审批版 ${update.latestVersion}。` : "不会派发未批准版本。"}`
      : update?.blockedReason
        ? `发现 ${update.latestVersion}，但${update.blockedReason}。`
        : update?.updateAvailable
          ? `发现稳定版 ${update.latestVersion}。升级前会备份二进制并验证现有配置。`
          : update?.status === "ready"
            ? `当前已是最新兼容稳定版${update.latestVersion ? `（${update.latestVersion}）` : ""}。`
            : "尚未检查稳定版更新。";
  }
  if (upgradeButton) {
    upgradeButton.hidden = update?.updateAvailable !== true || installation.platform !== "linux";
    upgradeButton.textContent = update?.latestVersion
      ? `安全升级到 ${update.latestVersion}`
      : "安全升级";
  }
  const certificateEmail = document.querySelector("#certificate-email");
  if (
    certificateEmail
    && document.activeElement !== certificateEmail
  ) {
    certificateEmail.value = controlPlane.certificate?.email || "";
  }
  const certificateMode = document.querySelector("#certificate-mode");
  if (certificateMode) {
    const configured = Boolean(controlPlane.certificate?.email);
    certificateMode.className = `status-badge ${configured ? "good" : "warning"}`;
    certificateMode.innerHTML = `<i></i>${configured ? "已配置" : "未配置"}`;
  }
  const latestBackup = controlPlane.backups[0];
  const backupTitle = document.querySelector("#system-backup-title");
  const backupState = document.querySelector("#system-backup-state");
  if (backupTitle) {
    backupTitle.textContent = latestBackup
      ? `最近备份 ${new Date(latestBackup.createdAt).toLocaleString("zh-CN")}`
      : "尚无在线备份";
  }
  if (backupState) {
    backupState.textContent = latestBackup
      ? `${(Number(latestBackup.sizeBytes || 0) / 1024 / 1024).toFixed(2)} MB · SHA-256 ${String(latestBackup.checksum || "").slice(0, 12)}… · 完整性 ${latestBackup.integrity}`
      : "每天自动执行 SQLite 在线备份，并校验 SHA-256 与数据库完整性。";
  }
  renderAdminAccess();
}

function renderReadiness() {
  const report = controlPlane.readiness;
  const target = document.querySelector("#readiness-checks");
  if (!target) return;
  if (!report) {
    setText("#readiness-summary", "尚无体检结果，请刷新后查看。");
    target.replaceChildren();
    setText("#readiness-limitations", "");
    return;
  }
  const summary = report.summary;
  const labels = { healthy: "控制面检查通过", blocked: "存在需处理的异常", attention: "仍有项目待确认" };
  setText("#readiness-summary", `${labels[report.status] || "待确认"} · ${summary.pass} 项通过 / ${summary.fail} 项异常 / ${summary.warning} 项警告 / ${summary.unknown} 项待确认 · ${new Date(report.generatedAt).toLocaleString("zh-CN")}`);
  const statuses = {
    fail: { label: "异常", className: "danger", order: 0 },
    warning: { label: "警告", className: "warning", order: 1 },
    unknown: { label: "待确认", className: "neutral", order: 2 },
    pass: { label: "通过", className: "good", order: 3 }
  };
  target.innerHTML = [...report.checks].sort((a, b) => statuses[a.status].order - statuses[b.status].order).map((check) => {
    const state = statuses[check.status];
    const hostIndex = /^host:(\d+):/.exec(check.id)?.[1];
    const hostName = hostIndex === undefined ? "" : controlPlane.hosts[Number(hostIndex)]?.name;
    return `<article class="readiness-row">
      <span class="status-badge ${state.className}"><i></i>${state.label}</span>
      <div><strong>${escapeHtml(check.title)}${hostName ? ` · ${escapeHtml(hostName)}` : ""}</strong><p>${escapeHtml(check.detail)}</p>
      ${check.observedAt ? `<small>证据时间 ${escapeHtml(new Date(check.observedAt).toLocaleString("zh-CN"))}</small>` : ""}</div>
      <button class="text-button" data-readiness-target="${escapeHtml(check.target)}">${escapeHtml(check.action)}</button>
    </article>`;
  }).join("");
  setText("#readiness-limitations", `${report.limitations.join(" ")} 导出不包含主机地址、用户资料、订阅密钥或原始配置；“主机 N”对应当前列表顺序。`);
}

async function refreshReadiness(button, exportReport = false) {
  button.disabled = true;
  try {
    const report = await api("/api/operations/readiness", { signal: AbortSignal.timeout(10_000) });
    controlPlane.readiness = report;
    renderReadiness();
    if (exportReport) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `raylink-readiness-${report.generatedAt.replace(/[:.]/g, "-")}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      showToast("报告已导出", "已导出当前检查结论、证据时间与处理建议。");
    } else {
      showToast("体检已刷新", "已重新汇总运行证据；协议测速请进入对应主机执行。");
    }
  } catch (error) {
    showToast(exportReport ? "导出失败" : "体检刷新失败", error.message);
  } finally {
    button.disabled = false;
  }
}

function syncMcpCreateButton() {
  document.querySelector("#mcp-create-submit").disabled = controlPlane.currentAdmin?.role !== "owner"
    || !mcpAccess.scopes.length || !mcpAccess.endpoint || mcpAccess.loading || mcpAccess.creating || Boolean(mcpAccess.issued);
  document.querySelector("[data-refresh-mcp]").disabled = mcpAccess.loading || mcpAccess.creating;
}

function clearMcpSecret() {
  mcpAccess.issued = null;
  document.querySelector("#mcp-issued-token").value = "";
  document.querySelector("#mcp-issued-config").value = "";
  document.querySelector("#mcp-issued").hidden = true;
  syncMcpCreateButton();
}

function clearMcpAccess() {
  mcpAccess.generation += 1;
  mcpAccess.tokens = [];
  mcpAccess.scopes = [];
  mcpAccess.endpoint = "";
  mcpAccess.loading = false;
  mcpAccess.creating = false;
  clearMcpSecret();
  document.querySelector("#mcp-create-form").reset();
  document.querySelector("#mcp-endpoint").value = "";
  document.querySelector("#mcp-scope-list").replaceChildren();
  applyMcpPreset("read");
  document.querySelector("#mcp-token-list").replaceChildren();
  document.querySelector("[data-refresh-mcp]").disabled = false;
  setText("#mcp-access-status", "打开此页后读取凭据。");
}

function mcpSessionIsCurrent(generation, adminId) {
  return generation === mcpAccess.generation && controlPlane.currentAdmin?.id === adminId
    && controlPlane.currentAdmin?.role === "owner";
}

function handleMcpError(error, title) {
  if (error.status === 401) { showAdminLogin(); return; }
  if (error.status === 403) clearMcpAccess();
  setText("#mcp-access-status", error.message);
  showToast(title, error.message);
}

function renderMcpScopes() {
  const target = document.querySelector("#mcp-scope-list");
  const selected = target.children.length
    ? new Set([...target.querySelectorAll("input:checked")].map((input) => input.value))
    : new Set(["read"]);
  const sensitive = (scope) => ["secrets.read", "admins.manage"].includes(scope.id);
  const scopes = [...mcpAccess.scopes.filter((scope) => !sensitive(scope)), ...mcpAccess.scopes.filter(sensitive)];
  target.innerHTML = scopes.map((scope) => `<label class="mcp-scope-option">
    <input type="checkbox" name="scope" value="${escapeHtml(scope.id)}" ${selected.has(scope.id) ? "checked" : ""}>
    <span><strong>${escapeHtml(scope.label || scope.id)}${sensitive(scope) ? "<em>单独授权</em>" : ""}</strong><small>${escapeHtml(scope.description || scope.id)}</small></span>
  </label>`).join("");
}

function applyMcpPreset(preset) {
  const selected = new Set(preset === "operator" ? ["read", "users.manage", "runtime.manage"]
    : preset === "full" ? ["read", "users.manage", "runtime.manage", "system.manage", "audit.read"] : ["read"]);
  document.querySelectorAll('#mcp-scope-list input[name="scope"]').forEach((input) => { input.checked = selected.has(input.value); });
  document.querySelectorAll("[data-mcp-preset]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mcpPreset === preset));
  });
}

function renderMcpTokens() {
  const target = document.querySelector("#mcp-token-list");
  const date = (value) => value ? new Date(value).toLocaleString("zh-CN") : "尚未使用";
  const labels = new Map(mcpAccess.scopes.map((scope) => [scope.id, scope.label || scope.id]));
  target.innerHTML = mcpAccess.tokens.length ? mcpAccess.tokens.map((token) => {
    const expired = Date.parse(token.expiresAt) <= Date.now();
    const status = token.revokedAt ? "已撤销" : expired ? "已到期" : "有效";
    return `<article class="mcp-token-row"><div><strong>${escapeHtml(token.name)}</strong>
      <p>${escapeHtml(token.adminUsername || "管理员")} · ${escapeHtml((token.scopes || []).map((scope) => labels.get(scope) || scope).join("、"))}</p>
      <p>到期 ${escapeHtml(date(token.expiresAt))} · 最近使用 ${escapeHtml(date(token.lastUsedAt))}</p></div>
      <div class="mcp-token-actions"><span class="status-badge ${token.revokedAt || expired ? "neutral" : "good"}"><i></i>${status}</span>
      <button type="button" class="button secondary" data-revoke-mcp="${escapeHtml(token.id)}" ${token.revokedAt ? "disabled" : ""}>${token.revokedAt ? "已撤销" : "撤销"}</button></div></article>`;
  }).join("") : '<div class="empty-state">尚无 MCP 凭据。创建一个只读凭据开始使用。</div>';
}

async function loadMcpAccess() {
  if (controlPlane.currentAdmin?.role !== "owner" || mcpAccess.loading || mcpAccess.creating) return;
  const generation = mcpAccess.generation;
  const adminId = controlPlane.currentAdmin.id;
  const button = document.querySelector("[data-refresh-mcp]");
  mcpAccess.loading = true;
  syncMcpCreateButton();
  setText("#mcp-access-status", "正在读取凭据…");
  try {
    const data = await api("/api/mcp/tokens", { signal: AbortSignal.timeout(15_000) });
    if (!mcpSessionIsCurrent(generation, adminId)) return;
    mcpAccess.tokens = data.tokens || [];
    mcpAccess.scopes = data.scopes || [];
    mcpAccess.endpoint = data.endpoint || "";
    document.querySelector("#mcp-endpoint").value = mcpAccess.endpoint;
    renderMcpScopes();
    renderMcpTokens();
    if (mcpAccess.issued && mcpAccess.tokens.find((token) => token.id === mcpAccess.issued.id)?.revokedAt) clearMcpSecret();
    setText("#mcp-access-status", `${mcpAccess.tokens.length} 个凭据 · 列表更新于 ${new Date().toLocaleTimeString("zh-CN")}`);
  } catch (error) {
    if (mcpSessionIsCurrent(generation, adminId)) handleMcpError(error, "凭据加载失败");
  } finally {
    if (generation === mcpAccess.generation) {
      mcpAccess.loading = false;
      button.disabled = false;
      syncMcpCreateButton();
    }
  }
}

async function createMcpCredential(event) {
  event.preventDefault();
  if (controlPlane.currentAdmin?.role !== "owner" || mcpAccess.loading || mcpAccess.creating || mcpAccess.issued) return;
  const form = event.currentTarget;
  const scopes = [...form.querySelectorAll('input[name="scope"]:checked')].map((input) => input.value);
  if (!scopes.length) { setText("#mcp-access-status", "请至少选择一项权限。"); return; }
  const generation = mcpAccess.generation;
  const adminId = controlPlane.currentAdmin.id;
  mcpAccess.creating = true;
  syncMcpCreateButton();
  try {
    const created = await api("/api/mcp/tokens", { method: "POST", body: JSON.stringify({
      name: form.elements.name.value.trim(), scopes, expiresInDays: Number(form.elements.expiresInDays.value)
    }) });
    if (!mcpSessionIsCurrent(generation, adminId)) return;
    const { token, ...metadata } = created;
    mcpAccess.tokens = [metadata, ...mcpAccess.tokens.filter((entry) => entry.id !== metadata.id)];
    mcpAccess.issued = { id: metadata.id };
    document.querySelector("#mcp-issued-token").value = token;
    document.querySelector("#mcp-issued-config").value = JSON.stringify({ mcpServers: { raylink: {
      type: "http", url: mcpAccess.endpoint, headers: { Authorization: `Bearer ${token}` }
    } } }, null, 2);
    document.querySelector("#mcp-issued").hidden = false;
    renderMcpTokens();
    setText("#mcp-access-status", "凭据已创建。保存下方令牌后关闭一次性显示区，再创建其他凭据。");
    document.querySelector("#mcp-issued-token").focus();
  } catch (error) {
    if (mcpSessionIsCurrent(generation, adminId)) handleMcpError(error, "创建凭据失败");
  } finally {
    if (generation === mcpAccess.generation) { mcpAccess.creating = false; syncMcpCreateButton(); }
  }
}

async function revokeMcpCredential(button) {
  if (controlPlane.currentAdmin?.role !== "owner" || button.disabled) return;
  const generation = mcpAccess.generation;
  const adminId = controlPlane.currentAdmin.id;
  button.disabled = true;
  try {
    const revoked = await api(`/api/mcp/tokens/${encodeURIComponent(button.dataset.revokeMcp)}`, { method: "DELETE" });
    if (!mcpSessionIsCurrent(generation, adminId)) return;
    mcpAccess.tokens = mcpAccess.tokens.map((token) => token.id === revoked.id ? revoked : token);
    if (mcpAccess.issued?.id === revoked.id) clearMcpSecret();
    renderMcpTokens();
    setText("#mcp-access-status", "凭据已撤销，使用此令牌的新请求将被拒绝。");
    showToast("凭据已撤销", "已停止此 Agent 的访问权限。");
  } catch (error) {
    if (mcpSessionIsCurrent(generation, adminId)) { handleMcpError(error, "撤销失败"); button.disabled = false; }
  }
}

function renderAdminAccess() {
  const target = document.querySelector("#admin-access-list");
  const auditTarget = document.querySelector("#audit-event-list");
  if (target) {
    target.innerHTML = controlPlane.admins.length
      ? controlPlane.admins.map((admin) => `
        <div class="admin-access-row" data-admin-row="${escapeHtml(admin.id)}">
          <span><strong>${escapeHtml(admin.username)}</strong><small>创建于 ${new Date(admin.createdAt).toLocaleString("zh-CN")}</small></span>
          <select data-admin-role aria-label="${escapeHtml(admin.username)} 的角色">
            ${["owner", "operator", "support", "auditor"].map((role) => (
              `<option value="${role}" ${admin.role === role ? "selected" : ""}>${role}</option>`
            )).join("")}
          </select>
          <input data-admin-password type="password" minlength="12" autocomplete="new-password" placeholder="留空则不重置密码" aria-label="重置 ${escapeHtml(admin.username)} 的密码">
          <button class="button secondary" data-save-admin="${escapeHtml(admin.id)}">保存</button>
        </div>`).join("")
      : '<div class="empty-state">当前角色不能查看管理员列表。</div>';
  }
  if (auditTarget) {
    auditTarget.innerHTML = controlPlane.auditEvents.length
      ? controlPlane.auditEvents.map((event) => `
        <span><time>${new Date(event.createdAt).toLocaleString("zh-CN")}</time> ${escapeHtml(event.actorUsername)} · ${escapeHtml(event.action)} · ${escapeHtml(event.resourceType)}</span>
      `).join("")
      : "<span>尚无审计事件。</span>";
  }
}

async function createAdministrator(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api("/api/admins", {
      method: "POST",
      body: JSON.stringify({
        username: form.elements.username.value.trim(),
        password: form.elements.password.value,
        role: form.elements.role.value
      })
    });
    form.reset();
    await loadBootstrap();
    showToast("管理员已创建", "新账号已经按所选角色完成权限隔离。");
  } catch (error) {
    showToast("创建管理员失败", error.message);
  } finally {
    button.disabled = false;
  }
}

async function saveAdministrator(adminId) {
  const row = document.querySelector(
    `[data-admin-row="${CSS.escape(adminId)}"]`
  );
  if (!row) return;
  const button = row.querySelector("[data-save-admin]");
  const password = row.querySelector("[data-admin-password]").value;
  button.disabled = true;
  try {
    await api(`/api/admins/${encodeURIComponent(adminId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        role: row.querySelector("[data-admin-role]").value,
        ...(password ? { password } : {})
      })
    });
    if (password && adminId === controlPlane.currentAdmin?.id) {
      showAdminLogin();
      elements.authError.textContent = "密码已更新，请使用新密码重新登录。";
      return;
    }
    await loadBootstrap();
    showToast("管理员已更新", password ? "角色和登录密码已经更新。" : "管理员角色已经更新。");
  } catch (error) {
    showToast("更新管理员失败", error.message);
  } finally {
    button.disabled = false;
  }
}

async function createDatabaseBackup() {
  const button = document.querySelector("[data-create-backup]");
  if (!button || button.disabled) return;
  button.disabled = true;
  button.innerHTML = `${icon("refresh")} 正在备份`;
  try {
    const backup = await api("/api/backups", { method: "POST" });
    await loadBootstrap();
    showToast(
      "数据库备份完成",
      `${backup.filename} 已通过 SHA-256 与 SQLite 完整性检查。`
    );
  } catch (error) {
    showToast("数据库备份失败", error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon("rollback")} 立即备份`;
  }
}

async function saveCertificateSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const errorTarget = form.querySelector(".field-error");
  button.disabled = true;
  button.textContent = "正在保存…";
  errorTarget.textContent = "";
  errorTarget.classList.remove("visible");
  try {
    controlPlane.certificate = await api("/api/settings/certificate", {
      method: "PATCH",
      body: JSON.stringify({ email: form.elements.email.value.trim() })
    });
    renderSystem();
    showToast("证书邮箱已保存", "新的 ACME 一键启用任务会自动使用这个邮箱。");
  } catch (error) {
    errorTarget.textContent = error.message;
    errorTarget.classList.add("visible");
    showToast("保存失败", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "保存邮箱";
  }
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(`${value}T00:00:00`));
}

function renderUsers() {
  const query = elements.userSearch.value.trim().toLocaleLowerCase();
  const filtered = users.filter((user) => {
    const matchesFilter = activeUserFilter === "all" || user.state === activeUserFilter;
    const haystack = `${user.name} ${user.email} ${scopeToLabel(user.nodeScope)}`.toLocaleLowerCase();
    return matchesFilter && haystack.includes(query);
  });

  elements.userBody.innerHTML = filtered.map((user) => {
    const status = stateLabels[user.state];
    const ratio = Math.min(100, (user.used / user.quota) * 100);
    const progressClass = ratio >= 80 ? "warning" : "";
    return `
      <tr>
        <td>
          <button class="identity-link" data-user="${escapeHtml(user.email)}">
            <span class="avatar">${escapeHtml(user.initials)}</span>
            <span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}</small></span>
          </button>
        </td>
        <td><span class="status-badge ${status.className}"><i></i>${status.label}</span></td>
        <td class="usage-cell">
          <div class="usage-copy"><span>${user.used.toFixed(1)} GB</span><span>${user.quota} GB</span></div>
          <div class="progress ${progressClass}"><i style="width:${ratio.toFixed(1)}%"></i></div>
        </td>
        <td><span class="entitlement-cell"><strong>${escapeHtml(scopeToLabel(user.nodeScope))}</strong><small>通用订阅</small></span></td>
        <td class="numeric">${formatDate(user.expires)}</td>
        <td>
          <button
            class="subscription-quick-button"
            type="button"
            data-user-subscription-quick="${escapeHtml(user.id)}"
            aria-label="${user.subscription?.configured ? "查看" : "生成"} ${escapeHtml(user.name)} 的订阅链接和二维码"
          >${icon("link")}<span>${user.subscription?.configured ? "查看订阅" : "生成订阅"}</span></button>
        </td>
        <td><button class="icon-button small" aria-label="编辑 ${escapeHtml(user.name)}" data-user="${escapeHtml(user.email)}">${icon("more")}</button></td>
      </tr>`;
  }).join("");

  elements.userCount.textContent = `显示 ${filtered.length} / ${accountSummary.totalUsers} 位用户`;
  document.querySelectorAll('.nav-item[data-view-target="users"] .nav-count').forEach((count) => {
    count.textContent = accountSummary.totalUsers;
  });
  document.querySelectorAll("[data-user-filter]").forEach((button) => {
    const filterName = button.dataset.userFilter;
    const count = filterName === "all" ? users.length : users.filter((user) => user.state === filterName).length;
    const badge = button.querySelector("span");
    if (badge) badge.textContent = count;
  });
  if (!filtered.length) {
    elements.userBody.innerHTML = `<tr><td colspan="7"><div class="empty-state">没有符合当前筛选条件的用户</div></td></tr>`;
  }
}

function navigate(viewName, updateHash = true) {
  const legacyOperationsRoute = viewName === "operations";
  const aliases = {
    "users/plans": "users",
    subscriptions: "users",
    hosts: "system",
    deploy: "system",
    operations: "system"
  };
  const normalizedView = aliases[viewName] || viewName;
  const target = document.querySelector(`[data-view="${normalizedView}"]`) || document.querySelector('[data-view="not-found"]');
  const resolvedView = target.dataset.view;
  document.documentElement.classList.toggle(
    "hide-root-scrollbar",
    resolvedView === "system"
  );
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view === target));

  document.querySelectorAll("[data-view-target]").forEach((button) => {
    const active = button.dataset.viewTarget === resolvedView;
    button.classList.toggle("active", active);
    if (button.classList.contains("nav-item")) {
      button.toggleAttribute("aria-current", active);
    }
  });

  const railItem = document.querySelector(`.nav-item[data-view-target="${resolvedView}"]`);
  if (railItem) {
    const allItems = [...document.querySelectorAll(".nav-item")];
    const index = allItems.indexOf(railItem);
    elements.indicator.style.transform = `translateY(${index * 48}px)`;
  }

  const headings = {
    dashboard: "总览",
    users: "用户",
    policies: "策略",
    system: "系统",
    "not-found": "未找到"
  };
  document.title = `${headings[resolvedView]} · RayLink`;
  if (updateHash) {
    history.pushState({ view: resolvedView }, "", `#/${resolvedView}`);
  } else if (normalizedView !== viewName) {
    history.replaceState({ view: normalizedView }, "", `#/${normalizedView}`);
  }
  if (legacyOperationsRoute) {
    selectWorkspaceTab("system", "maintenance");
  }
  elements.rail.classList.remove("open");
  elements.rail.toggleAttribute("inert", window.innerWidth <= 920);
  elements.menuToggle.setAttribute("aria-expanded", "false");
  window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function showToast(title, message) {
  clearTimeout(toastTimer);
  elements.toastTitle.textContent = title;
  elements.toastMessage.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 3200);
}

function setProfileMenu(open) {
  elements.profileMenu.hidden = !open;
  elements.profileMenuTrigger.setAttribute("aria-expanded", String(open));
}

function showAdminLogin() {
  clearMcpAccess();
  if (bootstrapRefreshTimer) {
    clearInterval(bootstrapRefreshTimer);
    bootstrapRefreshTimer = null;
  }
  setProfileMenu(false);
  closeDrawer({ restoreFocus: false, clearContent: true });
  document.documentElement.classList.remove("hide-root-scrollbar");
  controlPlane.currentAdmin = null;
  elements.authError.textContent = "";
  elements.authForm.elements.password.value = "";
  elements.authScreen.hidden = false;
  elements.appShell.hidden = true;
  elements.mobileNav.hidden = true;
  elements.toast.classList.remove("visible");
  subscriptionSession.clear();
  history.replaceState({}, "", location.pathname);
  elements.authForm.elements.username.focus();
}

async function logoutControlPlane(button) {
  clearMcpAccess();
  button.disabled = true;
  const previousMarkup = button.innerHTML;
  button.textContent = "正在退出…";
  let sessionEnded = false;
  try {
    await api("/api/auth/logout", { method: "POST" });
    sessionEnded = true;
  } catch (error) {
    if (error.status === 401) {
      sessionEnded = true;
    } else {
      showToast("退出失败", error.message);
    }
  } finally {
    button.disabled = false;
    button.innerHTML = previousMarkup;
  }
  if (sessionEnded) showAdminLogin();
}

function openDrawer({ title, eyebrow, content, saveLabel = "保存更改" }) {
  lastFocusedElement = document.activeElement;
  elements.drawerTitle.textContent = title;
  elements.drawerEyebrow.textContent = eyebrow;
  elements.drawerContent.innerHTML = content;
  elements.drawerSave.textContent = saveLabel;
  elements.drawer.classList.add("open");
  elements.drawerScrim.classList.add("open");
  elements.drawer.setAttribute("aria-hidden", "false");
  elements.drawer.removeAttribute("inert");
  document.body.style.overflow = "hidden";
  setTimeout(() => elements.drawerClose.focus(), 50);
}

function closeDrawer({ restoreFocus = true, clearContent = false } = {}) {
  elements.drawer.classList.remove("open");
  elements.drawerScrim.classList.remove("open");
  elements.drawer.setAttribute("aria-hidden", "true");
  elements.drawer.setAttribute("inert", "");
  document.body.style.overflow = "";
  const focusTarget = lastFocusedElement;
  lastFocusedElement = null;
  if (clearContent) elements.drawerContent.replaceChildren();
  if (restoreFocus) focusTarget?.focus();
}

function userPortalUrl() {
  return new URL(
    "/portal",
    controlPlane.access?.canonicalOrigin || window.location.origin
  ).toString();
}

function userSubscriptionAccessMarkup(user) {
  const generatedUrl = subscriptionSession.get(user.id);
  const configured = user.subscription?.configured === true;
  const status = generatedUrl
    ? "订阅地址已生成，可复制链接或扫描二维码。"
    : configured
      ? user.subscription?.recoverable
        ? "正在读取现有订阅地址…"
        : "现有地址由旧版本生成，需要重新生成一次；之后可随时查看。"
      : "尚未生成。生成后可复制链接或让用户扫描二维码。";
  return `
    <section class="user-access-card" data-user-subscription-panel>
      <div>
        <strong>用户中心登录</strong>
        <small>用户访问下面的地址，使用邮箱 ${escapeHtml(user.email)} 和管理员设置的密码登录。</small>
      </div>
      <div class="secure-link-row">
        <input id="user-portal-url" type="url" value="${escapeHtml(userPortalUrl())}" readonly spellcheck="false">
        <button type="button" class="button secondary" data-copy-target="user-portal-url">${icon("copy")}复制</button>
      </div>
      <div class="subscription-access">
        <div>
          <strong>订阅地址</strong>
          <small data-user-subscription-status>${status}</small>
        </div>
        <div class="subscription-result" data-user-subscription-result ${generatedUrl ? "" : "hidden"}>
          <div class="subscription-qr" data-user-subscription-qr aria-label="用户订阅地址二维码"></div>
          <div class="secure-link-row">
            <input id="user-subscription-url" type="url" value="${escapeHtml(generatedUrl)}" readonly spellcheck="false">
            <button type="button" class="button secondary" data-copy-target="user-subscription-url">${icon("copy")}复制</button>
          </div>
          <div class="subscription-client-picker">
            <div class="subscription-client-heading">
              <strong>选择客户端</strong>
              <small>按设备选择导入方式，订阅内容保持一致。</small>
            </div>
            <div class="subscription-client-actions">
              <a class="subscription-client-action recommended" href="#" data-subscription-format="mihomo" data-subscription-import="clash">
                <span><strong>Clash / Mihomo</strong><small>Windows · macOS · Android</small></span>
                <span class="subscription-client-badge">推荐</span>
              </a>
              <a class="subscription-client-action" href="#" data-subscription-format="loon">
                <span><strong>Loon 节点</strong><small>保留客户端现有规则</small></span>
                <span class="subscription-client-badge">添加</span>
              </a>
              <a class="subscription-client-action" href="#" data-subscription-format="egern-profile" data-subscription-import="egern-profile">
                <span><strong>Egern 完整配置</strong><small>智能策略、分流与 DNS</small></span>
                <span class="subscription-client-badge">导入</span>
              </a>
              <a class="subscription-client-action" href="#" data-subscription-format="egern" data-subscription-import="egern">
                <span><strong>Egern 节点</strong><small>保留客户端现有规则</small></span>
                <span class="subscription-client-badge">添加</span>
              </a>
              <a class="subscription-client-action" href="#" data-subscription-format="singbox">
                <span><strong>sing-box JSON</strong><small>需要 sing-box 1.14 或更新版本</small></span>
                <span class="subscription-client-badge">下载</span>
              </a>
            </div>
          </div>
          <small class="subscription-secret-note">二维码与链接包含用户凭据，请通过安全渠道交付。地址在服务端加密保存，刷新页面后仍可查看。</small>
        </div>
        <button
          type="button"
          class="button primary"
          data-user-subscription-action
          data-user-id="${escapeHtml(user.id)}"
          data-subscription-configured="${configured ? "true" : "false"}"
        >${configured ? "重新生成订阅地址" : "生成订阅地址"}</button>
      </div>
    </section>`;
}

function userPasswordResetMarkup(user) {
  return `
    <section class="user-access-card" data-user-password-reset>
      <div>
        <strong>重置用户中心密码</strong>
        <small>重置后所有已登录设备需要重新登录；用户权益、协议凭据和订阅地址保持不变。</small>
      </div>
      <label class="field">
        <span>新密码</span>
        <input name="resetPassword" type="password" minlength="8" autocomplete="new-password" placeholder="至少 8 位">
        <small class="field-error"></small>
      </label>
      <label class="field">
        <span>确认新密码</span>
        <input name="confirmResetPassword" type="password" minlength="8" autocomplete="new-password" placeholder="再次输入新密码">
        <small class="field-error"></small>
      </label>
      <button
        type="button"
        class="button secondary"
        data-reset-user-password
        data-user-id="${escapeHtml(user.id)}"
      >重置密码</button>
    </section>`;
}

function userDrawerMarkup(user = {}) {
  const isNew = !user.id;
  const selectedNodeGroup = user.nodeScope?.length ? scopeToLabel(user.nodeScope) : "全部节点";
  const currentHostRegion = controlPlane.hosts[0]?.region;
  const standardNodeGroups = [
    selectedNodeGroup,
    "全部节点",
    currentHostRegion ? scopeToLabel([currentHostRegion]) : null,
    "东京 + 新加坡"
  ].filter(Boolean);
  const nodeGroupOptions = [...new Set(standardNodeGroups)]
    .map((nodeGroup) => `<option ${nodeGroup === selectedNodeGroup ? "selected" : ""}>${escapeHtml(nodeGroup)}</option>`)
    .join("");
  return `
    <form class="drawer-form" id="user-drawer-form" data-user-id="${escapeHtml(user.id || "")}">
      <div class="drawer-profile">
        <span class="avatar">${escapeHtml(user.initials || "新")}</span>
        <div><strong>${escapeHtml(user.name || "新用户")}</strong><small>${isNew ? "一次完成账号与权益设置" : escapeHtml(user.email)}</small></div>
      </div>
      <p class="drawer-section-label">基本信息</p>
      <label class="field"><span>显示名称</span><input name="name" value="${escapeHtml(user.name || "")}" placeholder="例如：徐清扬" required><small class="field-error"></small></label>
      <label class="field"><span>邮箱</span><input name="email" type="email" value="${escapeHtml(user.email || "")}" placeholder="name@company.com" required><small class="field-error"></small></label>
      ${isNew ? '<label class="field"><span>初始密码</span><input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="至少 8 位" required><small class="field-error"></small></label>' : ""}
      <label class="field"><span>到期时间</span><input name="expires" type="date" value="${escapeHtml(user.expires || "2026-12-31")}" required><small class="field-error"></small></label>
      <label class="field"><span>已用流量</span><input name="usedGb" type="number" min="0" step="0.1" value="${Number(user.used || 0).toFixed(1)}" required><small class="field-error"></small><small class="field-hint">由支持 with_v2ray_api 的 Runtime 自动计量；管理员可在账务校正时调整</small></label>
      <p class="drawer-section-label">用户权益</p>
      <label class="field"><span>流量额度（GB）</span><input name="quota" type="number" min="1" step="1" value="${Number(user.quota || 120)}" required><small class="field-error"></small></label>
      <label class="field"><span>节点范围</span><select name="nodeGroup">${nodeGroupOptions}</select><small class="field-hint">该用户只能获取所选区域的客户端配置</small></label>
      <p class="drawer-section-label">平台订阅能力</p>
      <div class="switch-row"><div><strong>多客户端订阅</strong><small>自动提供 Mihomo、Egern 与 sing-box 三种兼容配置</small></div><span class="status-badge good"><i></i>固定启用</span></div>
      <p class="drawer-section-label">账号状态</p>
      <div class="switch-row"><div><strong>启用账号</strong><small>允许登录用户中心并使用自己的流量、节点与订阅服务</small></div><button type="button" class="switch ${user.state !== "disabled" ? "on" : ""}" data-user-enabled role="switch" aria-checked="${user.state !== "disabled"}"></button></div>
      <div class="switch-row"><div><strong>${isNew ? "创建后激活用户中心" : "允许登录用户中心"}</strong><small>登录账号使用当前邮箱，密码与 Runtime 凭据相互独立</small></div><button type="button" class="switch ${isNew || user.portalStatus === "active" ? "on" : ""}" data-portal-enabled role="switch" aria-checked="${isNew || user.portalStatus === "active"}"></button></div>
      ${isNew ? "" : `
        <p class="drawer-section-label">登录安全</p>
        ${userPasswordResetMarkup(user)}
        <p class="drawer-section-label">用户中心与订阅访问</p>
        ${userSubscriptionAccessMarkup(user)}`}
    </form>`;
}

async function hydrateUserSubscriptionPanel(scope, userId) {
  const hydrated = subscriptionQuick.hydrate({
    scope,
    userId,
    session: subscriptionSession,
    qrRenderer: (container, value) => window.RayLinkSubscriptionQr?.render(container, value)
  });
  if (hydrated) return;
  const user = users.find((candidate) => candidate.id === userId);
  if (!user?.subscription?.configured) return;
  const panel = scope.querySelector("[data-user-subscription-panel]");
  const status = panel?.querySelector("[data-user-subscription-status]");
  if (!panel || !status) return;
  try {
    const result = await api(
      `/api/users/${encodeURIComponent(userId)}/subscription`
    );
    const qrReady = subscriptionQuick.reveal({
      panel,
      userId,
      url: result.subscriptionUrl,
      session: subscriptionSession,
      qrRenderer: (container, value) => window.RayLinkSubscriptionQr?.render(container, value)
    });
    status.textContent = qrReady
      ? "现有订阅地址已载入，可复制或扫描二维码。"
      : "现有订阅地址已载入，二维码暂不可用，请复制链接。";
  } catch (error) {
    status.textContent = error.message;
  }
}

function openUser(email) {
  const user = users.find((item) => item.email === email);
  if (!user) return;
  openDrawer({ title: user.name, eyebrow: "用户详情", content: userDrawerMarkup(user) });
  hydrateUserSubscriptionPanel(elements.drawerContent, user.id);
}

function openUserSubscriptionQuick(userId) {
  const user = users.find((item) => item.id === userId);
  if (!user) return;
  openDrawer({
    title: `${user.name} · 订阅`,
    eyebrow: "快捷访问",
    content: `
      <div class="quick-subscription-panel">
        <div class="drawer-profile">
          <span class="avatar">${escapeHtml(user.initials)}</span>
          <div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}</small></div>
        </div>
        ${userSubscriptionAccessMarkup(user)}
      </div>`,
    saveLabel: "关闭"
  });
  hydrateUserSubscriptionPanel(elements.drawerContent, user.id);
}

function openNewUser() {
  openDrawer({ title: "新建用户", eyebrow: "访问控制", content: userDrawerMarkup(), saveLabel: "创建用户" });
}

const protocolStatePresentation = {
  configuring: ["配置中", "warning"],
  "pending-publish": ["待发布", "warning"],
  deploying: ["正在部署", "warning"],
  "port-listening": ["端口已监听", "good"],
  "public-ready": ["公网可用", "good"],
  failed: ["启用失败", "danger"]
};

function protocolState(host, profile, applied) {
  const activation = host.protocolActivations?.find((item) => item.type === profile.type);
  if (activation && protocolStatePresentation[activation.state]) {
    const [label, className] = protocolStatePresentation[activation.state];
    return { label, className, activation };
  }
  const pending = applied
    ? JSON.stringify(profile) !== JSON.stringify(applied)
    : profile.enabled;
  return {
    label: pending ? "待发布" : profile.enabled ? "端口已监听" : "未启用",
    className: pending ? "warning" : profile.enabled ? "good" : "neutral",
    activation: null
  };
}

function hostDrawerMarkup(hostId) {
  const host = controlPlane.hosts.find((item) => item.id === hostId);
  const isRemote = host.kind === "remote";
  const nodeNeedsUpgrade = isRemote
    && host.enrolledAt
    && host.agentVersion !== requiredNodeAgentVersion;
  const runtimeUpdate = controlPlane.runtimeUpdate;
  const runtimeCanUpgrade = isRemote
    && !nodeNeedsUpgrade
    && runtimeUpdate?.compatible !== false
    && runtimeUpdate?.latestVersion
    && host.runtimeUpgrade?.pending !== true
    && (
      versionIsOlder(host.runtimeVersion, runtimeUpdate.latestVersion)
      || (
        host.runtimeVersion === runtimeUpdate.latestVersion
        && host.usageMetering?.supported !== true
      )
    );
  const nodeUpgradeCommand = [
    'raylink_node_tmp="$(mktemp)"',
    `curl -fsSL ${shellQuote(`${location.origin}/node/upgrade.sh`)} -o "$raylink_node_tmp"`,
    `sudo env RAYLINK_SERVER=${shellQuote(location.origin)} bash "$raylink_node_tmp"`,
    'rm -f "$raylink_node_tmp"'
  ].join(" && ");
  const runtimeCopy = isRemote
    ? `${host.status === "online" ? "在线" : host.status === "pending" ? "等待接入" : "需要检查"} · ${host.runtimeVersion || host.agentVersion || "尚未上报版本"}`
    : `${controlPlane.runtime?.mode || "dry-run"} · ${controlPlane.runtime?.configPath || "尚未生成配置"}`;
  const deploymentApplicationCopy = host.deploymentSync?.status === "revocation-pending"
    ? `撤权配置正在等待节点确认，队列中 ${host.deploymentSync.pendingTaskCount} 项；节点恢复后会优先、持续重试。`
    : host.deploymentSync?.status === "pending"
      ? `有 ${host.deploymentSync.pendingTaskCount} 项配置等待节点应用。`
      : "节点已应用控制面配置。";
  const protocolRows = (host.protocols || []).map((profile) => {
    const catalog = (host.protocolCatalog || controlPlane.protocolCatalog)
      .find((item) => item.type === profile.type);
    const name = catalog?.name || profile.type;
    const port = profile.port ? `:${profile.port}` : "无固定端口";
    const applied = host.appliedProtocols?.find((item) => item.type === profile.type);
    const state = protocolState(host, profile, applied);
    const connection = protocolHealth.present(state.activation);
    return {
      group: catalog?.activationPolicy?.group || "advanced",
      html: `
      <button type="button" class="switch-row protocol-host-row" data-host-protocol="${escapeHtml(profile.type)}" data-host-id="${escapeHtml(host.id)}">
        <div><strong>${escapeHtml(name)}</strong><small>${escapeHtml(profile.listen)}${escapeHtml(port)} · ${profile.tls?.mode === "reality" ? "Reality" : ["certificate", "acme"].includes(profile.tls?.mode) ? "TLS" : "标准入口"}${profile.enabled ? ` · ${escapeHtml(connection.summary)}` : ""}</small></div>
        <span class="status-badge ${state.className}"><i></i>${state.label}</span>
      </button>`
    };
  });
  const groupMarkup = [
    {
      key: ["one-click", "tls", "udp-tls"],
      label: "一键启用",
      hint: "自动端口、密钥或证书、防火墙、发布与可用性检查"
    },
    {
      key: ["private"],
      label: "仅本机服务",
      hint: "固定监听 127.0.0.1，不暴露公网"
    },
    {
      key: ["advanced"],
      label: "高级协议",
      hint: "涉及系统网络或协议编排，需要手动配置"
    }
  ].map((group) => {
    const rows = protocolRows.filter((row) => group.key.includes(row.group));
    if (!rows.length) return "";
    return `<div class="protocol-group"><div class="protocol-group-heading"><strong>${group.label}</strong><small>${group.hint}</small></div>${rows.map((row) => row.html).join("")}</div>`;
  }).join("");
  const enabledProtocolCount = (host.protocols || []).filter((profile) => profile.enabled).length;
  const eligibleUserCount = users.filter((user) => userCanUseHost(user, host.region)).length;
  const activeDeployment = controlPlane.deployments.find((deployment) => deployment.status === "active");
  const runtimeHealthy = isRemote
    ? host.telemetry?.serviceStatus === "running"
    : ["running", "staged"].includes(controlPlane.runtime?.state);
  const hostDiagnostics = [
    {
      name: isRemote ? "Node 连接" : "sing-box 安装",
      detail: isRemote
        ? host.status === "online" ? "节点心跳正常" : "节点尚未在线"
        : controlPlane.installation?.installed
          ? `已安装 ${controlPlane.installation.version || "可用版本"}`
          : "当前主机尚未安装",
      pass: isRemote ? host.status === "online" : controlPlane.installation?.installed
    },
    {
      name: "Runtime 服务",
      detail: isRemote
        ? host.telemetry?.serviceStatus || "等待节点上报"
        : controlPlane.runtime?.state || "unknown",
      pass: runtimeHealthy
    },
    {
      name: "入口协议",
      detail: `${enabledProtocolCount} 个协议已启用`,
      pass: enabledProtocolCount > 0
    },
    {
      name: "配置应用",
      detail: isRemote ? deploymentApplicationCopy : activeDeployment?.version || "尚未发布",
      pass: isRemote
        ? Boolean(host.enrolledAt) && !host.deploymentSync?.pendingTaskCount
        : Boolean(activeDeployment)
    },
    {
      name: "有效用户",
      detail: `${eligibleUserCount} 位用户可使用此主机`,
      pass: eligibleUserCount > 0
    }
  ];
  const diagnosticMarkup = hostDiagnostics.map((check) => `
    <article class="${check.pass ? "pass" : "warning"}">
      <span>${check.pass ? icon("check") : "!"}</span>
      <div><strong>${escapeHtml(check.name)}</strong><small>${escapeHtml(check.detail)}</small></div>
    </article>`).join("");
  return `
    <form class="drawer-form" id="host-drawer-form" data-host-id="${escapeHtml(host.id)}">
      <div class="drawer-profile"><span class="avatar">${escapeHtml(host.name.slice(0, 1))}</span><div><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}</small></div></div>
      <p class="drawer-section-label">主机连接</p>
      <label class="field"><span>名称</span><input name="hostname" value="${escapeHtml(host.name)}" placeholder="例如：东京生产节点" required></label>
      <label class="field"><span>节点连接地址（每台 Host 独立）</span><input name="address" value="${escapeHtml(host.address)}" placeholder="node.example.com" required><small class="field-hint">每台 Host 可以使用不同的域名或公网 IP，订阅会使用这里的地址连接该节点。</small></label>
      <label class="field"><span>区域标识</span><input name="region" value="${escapeHtml(host.region)}" pattern="[A-Za-z0-9-]{2,32}" placeholder="tokyo" required></label>
      <p class="drawer-section-label">主机诊断</p>
      <div class="diagnostic-grid host-diagnostic-grid">${diagnosticMarkup}</div>
      <button type="button" class="button secondary" data-refresh-host-diagnostics="${escapeHtml(host.id)}">${icon("refresh")}刷新主机诊断</button>
      <p class="drawer-section-label">入口协议</p>
      <p class="field-hint">协议属于当前主机。一键启用会完成配置、校验、发布、端口检查，并在成功后自动进入用户订阅。</p>
      <div class="host-protocol-list">${groupMarkup}</div>
      <button type="button" class="button secondary" data-measure-host-latency="${escapeHtml(host.id)}">${icon("refresh")}测试全部协议连接</button>
      <p class="field-hint">每个公网协议执行 5 次完整握手与外部访问，显示中位连接耗时和抖动；连续 3 轮失败后才标记超时。本机及高级系统协议标记为不适用。</p>
      <div class="switch-row"><div><strong>${isRemote ? "RayLink Node" : "Runtime 模式"}</strong><small>${escapeHtml(runtimeCopy)}</small></div><span class="status-badge neutral"><i></i>${escapeHtml(isRemote ? host.status : controlPlane.runtime?.state || "unknown")}</span></div>
      ${!isRemote && !controlPlane.installation?.installed
        ? `<button type="button" class="button primary" id="install-sing-box">${icon("terminal")}一键安装 sing-box</button><p class="field-hint">安装完成后即可在当前主机启用入口协议。</p>`
        : ""}
      <div class="switch-row"><div><strong>用户流量计量</strong><small>${usageMeteringDescription(host.usageMetering)}</small></div><span class="status-badge ${host.usageMetering?.status === "healthy" ? "good" : host.usageMetering?.status === "error" ? "danger" : "warning"}"><i></i>${usageMeteringLabel(host.usageMetering)}</span></div>
      ${isRemote ? `<div class="switch-row"><div><strong>TLS 资产安全通道</strong><small>${host.assetEncryptionReady ? "节点 X25519 公钥已登记；证书私钥将以节点专属密封包下发。" : "请升级并重启 RayLink Node，使其生成并上报资产加密公钥。"}</small></div><span class="status-badge ${host.assetEncryptionReady ? "good" : "warning"}"><i></i>${host.assetEncryptionReady ? "已就绪" : "待升级"}</span></div>` : ""}
      ${isRemote ? `<div class="switch-row"><div><strong>配置应用</strong><small>${escapeHtml(deploymentApplicationCopy)}</small></div><span class="status-badge ${host.deploymentSync?.critical ? "danger" : host.deploymentSync?.pendingTaskCount ? "warning" : "good"}"><i></i>${escapeHtml(host.deploymentSync?.status === "revocation-pending" ? "撤权待应用" : host.deploymentSync?.status === "pending" ? "待应用" : "已应用")}</span></div>` : ""}
      ${isRemote && !host.enrolledAt
        ? `<button type="button" class="button secondary" data-reissue-host="${escapeHtml(host.id)}">${icon("refresh")}重新生成接入命令</button><p class="field-hint">新的接入令牌会立即替换之前的令牌。</p>`
        : ""}
      ${nodeNeedsUpgrade
        ? `<p class="drawer-section-label">Node 升级</p><p class="field-hint">当前 ${escapeHtml(host.agentVersion || "旧版")} 需要更新到 0.8.0 后才能升级 Runtime。0.7 节点仍可接收配置发布；更新只替换 Node 程序和构建器，保留身份与当前 Runtime。</p><pre class="advanced-preview"><code id="node-upgrade-command">${escapeHtml(nodeUpgradeCommand)}</code></pre><button type="button" class="button secondary" data-copy-target="node-upgrade-command">${icon("copy")}复制升级命令</button>`
        : ""}
      ${runtimeCanUpgrade
        ? `<p class="drawer-section-label">Runtime 升级</p><p class="field-hint">${host.runtimeVersion === runtimeUpdate.latestVersion ? `当前版本缺少真实计量能力，将按审批构建重新安装 ${escapeHtml(runtimeUpdate.latestVersion)}。` : `可从 ${escapeHtml(host.runtimeVersion || "未知版本")} 升级到审批版 ${escapeHtml(runtimeUpdate.latestVersion)}。`}节点会备份当前二进制、校验现有配置并在失败时自动回滚。</p><button type="button" class="button primary" data-upgrade-host="${escapeHtml(host.id)}">${icon("arrow")}升级 sing-box</button>`
        : ""}
      ${isRemote && host.runtimeUpgrade?.pending
        ? `<p class="drawer-section-label">Runtime 升级</p><div class="switch-row"><div><strong>升级任务执行中</strong><small>节点正在备份、安装、校验并重启服务。成功后心跳会更新版本；失败会自动恢复旧二进制。</small></div><span class="status-badge warning"><i></i>处理中</span></div>`
        : ""}
      ${isRemote && host.runtimeUpgrade?.status === "failed"
        ? `<p class="drawer-section-label">最近升级结果</p><div class="switch-row"><div><strong>${host.runtimeUpgrade.rolledBack ? `升级失败，已恢复 ${escapeHtml(host.runtimeUpgrade.previousVersion || "旧版本")}` : "升级与自动回滚失败"}</strong><small>${escapeHtml(host.runtimeUpgrade.error || "节点未返回错误详情")}${host.runtimeUpgrade.packageMetadataRestored === false ? " · 包管理器元数据需人工检查" : ""}${host.runtimeUpgrade.finishedAt ? ` · ${escapeHtml(new Date(host.runtimeUpgrade.finishedAt).toLocaleString("zh-CN"))}` : ""}</small></div><span class="status-badge ${host.runtimeUpgrade.rolledBack && host.runtimeUpgrade.packageMetadataRestored !== false ? "warning" : "danger"}"><i></i>${host.runtimeUpgrade.rolledBack && host.runtimeUpgrade.packageMetadataRestored !== false ? "已回滚" : "需人工处理"}</span></div>`
        : ""}
    </form>`;
}

function openHost(hostId) {
  const host = controlPlane.hosts.find((item) => item.id === hostId) || controlPlane.hosts[0];
  if (!host) return;
  openDrawer({
    title: host.name,
    eyebrow: "Runtime 主机",
    content: hostDrawerMarkup(host.id),
    saveLabel: "保存主机"
  });
}

function newHostDrawerMarkup() {
  return `
    <form class="drawer-form" id="new-host-drawer-form">
      <div class="drawer-profile"><span class="avatar">+</span><div><strong>添加第二台 VPS</strong><small>创建一次性接入令牌并安装 RayLink Node</small></div></div>
      <p class="drawer-section-label">节点信息</p>
      <label class="field"><span>名称</span><input name="hostname" placeholder="例如：法兰克福 02" required><small class="field-error"></small></label>
      <label class="field"><span>节点连接地址（每台 Host 独立）</span><input name="address" placeholder="node-frankfurt.example.com" required><small class="field-error"></small><small class="field-hint">每台 Host 可以使用不同的域名或公网 IP；该地址会写入用户客户端配置。</small></label>
      <label class="field"><span>区域标识</span><input name="region" pattern="[A-Za-z0-9-]{2,32}" placeholder="frankfurt" required><small class="field-error"></small><small class="field-hint">用户的“节点范围”会按此标识决定是否获得该节点。</small></label>
      <p class="drawer-section-label">接入过程</p>
      <div class="switch-row"><div><strong>1. 创建节点</strong><small>控制面生成仅可使用一次的接入令牌</small></div><span class="tag">当前步骤</span></div>
      <div class="switch-row"><div><strong>2. VPS 执行命令</strong><small>自动安装 sing-box 与 RayLink Node</small></div><span class="tag">下一步</span></div>
      <div class="switch-row"><div><strong>3. 自动上线</strong><small>节点心跳后即可接收发布配置</small></div><span class="tag">自动</span></div>
    </form>`;
}

function openNewHost() {
  openDrawer({
    title: "添加主机",
    eyebrow: "多节点接入",
    content: newHostDrawerMarkup(),
    saveLabel: "创建并生成命令"
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function enrollmentResultMarkup(created) {
  const origin = location.origin;
  const installUrl = `${origin}/node/install.sh`;
  const command = `curl -fsSL ${shellQuote(installUrl)} | sudo env RAYLINK_SERVER=${shellQuote(origin)} RAYLINK_ENROLL_TOKEN=${shellQuote(created.enrollmentToken)} bash`;
  const localOrigin = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  return `
    <div class="drawer-form">
      <div class="drawer-profile"><span class="avatar">${escapeHtml(created.host.name.slice(0, 1))}</span><div><strong>${escapeHtml(created.host.name)} 已创建</strong><small>${escapeHtml(created.host.address)} · 等待 RayLink Node 接入</small></div></div>
      <p class="drawer-section-label">在新 VPS 上执行</p>
      <pre class="advanced-preview"><code id="node-enrollment-command">${escapeHtml(command)}</code></pre>
      <button type="button" class="button secondary" data-copy-target="node-enrollment-command">${icon("copy")}复制安装命令</button>
      <p class="field-hint">${localOrigin
        ? "当前控制面地址是本机地址，远程 VPS 无法访问。正式使用时请从具有公网 HTTPS 域名的 RayLink 控制面生成命令。"
        : "令牌仅可注册一次；节点成功接入后会自动失效。安装程序会校验 Node.js 安装包并配置 systemd 自启动。"
      }</p>
      <p class="drawer-section-label">上线判定</p>
      <div class="switch-row"><div><strong>等待首次心跳</strong><small>执行命令后刷新页面；状态变为“在线”即完成。</small></div><span class="status-badge neutral"><i></i>等待接入</span></div>
    </div>`;
}

function protocolDrawerMarkup(hostId, type) {
  const host = controlPlane.hosts.find((item) => item.id === hostId);
  const protocol = (host?.protocolCatalog || controlPlane.protocolCatalog)
    .find((item) => item.type === type);
  const profile = host?.protocols?.find((item) => item.type === type);
  const applied = host?.appliedProtocols?.find((item) => item.type === type);
  const state = protocolState(host, profile, applied);
  const policy = protocol.activationPolicy || { group: "advanced", network: "tcp", exposure: "advanced" };
  const oneClick = !profile.enabled && policy.group !== "advanced";
  const tlsModes = [
    ["none", "不启用 TLS"],
    ["certificate", "证书 TLS"],
    ...(protocol.requiredTags?.includes("with_quic") || protocol.type === "naive"
      ? [["acme", "自动证书（ACME）"]]
      : []),
    ...(protocol.realityAvailable ? [["reality", "Reality"]] : [])
  ];
  const transportOptions = [
    "none",
    "ws",
    "http",
    ...(protocol.quicTransportAvailable ? ["quic"] : []),
    "grpc",
    "httpupgrade"
  ];
  return `
    <form class="drawer-form ${oneClick ? "protocol-one-click" : ""}" id="protocol-drawer-form" data-host-id="${escapeHtml(hostId)}" data-protocol-type="${escapeHtml(type)}">
      <div class="drawer-profile">
        <span class="avatar">${escapeHtml(type.slice(0, 2).toUpperCase())}</span>
        <div><strong>${escapeHtml(protocol.name)}</strong><small>${escapeHtml(protocol.description)}</small></div>
        <span class="status-badge ${state.className}"><i></i>${state.label}</span>
      </div>
      ${oneClick ? `<div class="protocol-activation-card">
        <strong>开启后即可使用</strong>
        <small>RayLink 将自动选择空闲 ${escapeHtml(policy.network.toUpperCase())} 端口，生成凭据${policy.tls === "reality" ? "和 Reality 密钥" : policy.tls === "managed-certificate" ? "并配置 Host 域名 TLS 证书" : ""}，配置防火墙，校验并发布 sing-box，检查可用后加入用户订阅。</small>
        ${state.activation?.state === "failed" ? `<small class="activation-error">上次启用失败：${escapeHtml(state.activation.error || "节点未返回错误详情")}${state.activation.rolledBack === false ? "；自动回滚未完整完成，请先检查节点。" : "；已自动回滚，可直接重试。"}</small>` : ""}
        <div class="activation-flow"><span>配置</span><i></i><span>发布</span><i></i><span>监听</span><i></i><span>${policy.exposure === "private" ? "本机可用" : "公网可用"}</span></div>
      </div>` : ""}
      <div class="switch-row">
        <div><strong>在 ${escapeHtml(host.name)} 启用</strong><small>${oneClick ? "点击底部“一键启用”后自动完成全部部署步骤。" : "手动修改会保存为待发布配置。"}</small></div>
        <button type="button" class="switch ${profile.enabled ? "on" : ""}" data-protocol-enabled role="switch" aria-checked="${profile.enabled}"></button>
      </div>
      <p class="drawer-section-label">监听设置</p>
      <label class="field"><span>监听地址</span><input name="listen" value="${escapeHtml(profile.listen)}" required><small class="field-hint">公网服务通常使用 ::，仅本机使用 127.0.0.1。</small></label>
      ${protocol.portless ? "" : `<label class="field"><span>监听端口</span><input name="port" type="number" min="1" max="65535" value="${profile.port}" required><small class="field-error"></small></label>`}
      ${protocol.tls === "none" || protocol.tls === "external" ? "" : `
        <p class="drawer-section-label">TLS 与 Reality</p>
        <label class="field"><span>TLS 模式</span><select name="tlsMode">${tlsModes.map(([value, label]) => `<option value="${value}" ${profile.tls.mode === value ? "selected" : ""}>${label}</option>`).join("")}</select><small class="field-hint">${protocol.tls === "required" ? "此协议启用时必须选择证书 TLS 或 Reality。" : "可按部署环境选配。"}</small></label>
        <label class="field"><span>服务器名称（SNI）</span><input name="serverName" value="${escapeHtml(profile.tls.serverName)}" placeholder="node.example.com"></label>
        <div class="quota-input">
          <label class="field"><span>ACME 通知邮箱</span><input name="acmeEmail" type="email" value="${escapeHtml(profile.tls.acmeEmail || "")}" placeholder="ops@example.com"></label>
          <label class="field"><span>ACME 数据目录</span><input name="acmeDataDirectory" value="${escapeHtml(profile.tls.acmeDataDirectory || "/var/lib/raylink/acme")}"></label>
        </div>
        <div class="quota-input">
          <label class="field"><span>证书路径</span><input name="certificatePath" value="${escapeHtml(profile.tls.certificatePath)}" placeholder="/etc/letsencrypt/live/node/fullchain.pem"></label>
          <label class="field"><span>私钥路径</span><input name="keyPath" value="${escapeHtml(profile.tls.keyPath)}" placeholder="/etc/letsencrypt/live/node/privkey.pem"></label>
        </div>
        ${protocol.realityAvailable ? `
          <div class="protocol-subsection">
            <div class="protocol-subsection-heading"><div><strong>Reality 参数</strong><small>密钥由本机 sing-box 生成。</small></div><button class="button secondary" type="button" data-generate-reality>生成密钥对</button></div>
            <div class="quota-input">
              <label class="field"><span>握手服务器</span><input name="handshakeServer" value="${escapeHtml(profile.tls.handshakeServer)}" placeholder="www.example.com"></label>
              <label class="field"><span>握手端口</span><input name="handshakePort" type="number" min="1" max="65535" value="${profile.tls.handshakePort || 443}"></label>
            </div>
            <label class="field"><span>Reality Private Key</span><input name="privateKey" value="${escapeHtml(profile.tls.privateKey)}" autocomplete="off"></label>
            <label class="field"><span>Reality Public Key</span><input name="publicKey" value="${escapeHtml(profile.tls.publicKey)}" autocomplete="off"></label>
            <label class="field"><span>Short ID</span><input name="shortId" value="${escapeHtml(profile.tls.shortId)}" placeholder="6ba85179e30d4fc2"></label>
          </div>` : ""}
      `}
      ${protocol.transports ? `
        <p class="drawer-section-label">V2Ray Transport</p>
        <label class="field"><span>传输方式</span><select name="transportType">${transportOptions.map((value) => `<option value="${value}" ${profile.transport.type === value ? "selected" : ""}>${value === "none" ? "原生 TCP" : value}</option>`).join("")}</select></label>
        <label class="field"><span>HTTP / WS / HTTPUpgrade 路径</span><input name="transportPath" value="${escapeHtml(profile.transport.path)}" placeholder="/raylink"><small class="field-hint">QUIC 不使用路径；选择 gRPC 时填写下方 Service Name。</small></label>
        <label class="field"><span>gRPC Service Name</span><input name="transportServiceName" value="${escapeHtml(profile.transport.serviceName)}" placeholder="raylink"></label>` : ""}
      ${type === "hysteria" ? `
        <p class="drawer-section-label">Hysteria 带宽</p>
        <div class="quota-input">
          <label class="field"><span>上传速率（Mbps）</span><input name="upMbps" type="number" min="1" value="${profile.options.up_mbps || 100}" required></label>
          <label class="field"><span>下载速率（Mbps）</span><input name="downMbps" type="number" min="1" value="${profile.options.down_mbps || 100}" required></label>
        </div>` : ""}
      <p class="drawer-section-label">高级选项</p>
      <label class="field"><span>附加 JSON 字段</span><textarea name="options" rows="7" spellcheck="false">${escapeHtml(JSON.stringify(profile.options, null, 2))}</textarea><small class="field-hint">字段会合并进该 inbound；type、tag、监听、用户、TLS 和 Transport 由 RayLink 管理，不能在此覆盖。</small><small class="field-error"></small></label>
      <div class="source-note"><span>能力来源：${escapeHtml(host.name)} · sing-box ${escapeHtml(host.runtimeVersion || (host.id === "local" ? controlPlane.installation?.version : null) || "未上报")}</span><a href="${escapeHtml(protocol.docsUrl)}" target="_blank" rel="noreferrer">查看官方字段 ↗</a></div>
    </form>`;
}

function openProtocol(hostId, type) {
  const host = controlPlane.hosts.find((item) => item.id === hostId);
  const protocol = (host?.protocolCatalog || controlPlane.protocolCatalog)
    .find((item) => item.type === type);
  const profile = host?.protocols?.find((item) => item.type === type);
  if (!protocol || !host) return;
  openDrawer({
    title: protocol.name,
    eyebrow: `${host.name} · 入口协议`,
    content: protocolDrawerMarkup(hostId, type),
    saveLabel: !profile?.enabled && protocol.activationPolicy?.group !== "advanced"
      ? "一键启用"
      : "保存协议"
  });
}

function portalLoginMarkup() {
  return `
    <form class="drawer-form portal-login-form" id="portal-login-form">
      <div class="drawer-profile">
        <span class="brand-mark"><img src="/assets/brand/raylink-mark.svg?v=20260726" alt="" aria-hidden="true"></span>
        <div><strong>登录 RayLink 用户中心</strong><small>使用管理员为你创建的账号</small></div>
      </div>
      <label class="field"><span>登录邮箱</span><input name="portalEmail" type="email" placeholder="user@example.com" required><small class="field-error"></small></label>
      <label class="field"><span>密码</span><input name="portalPassword" type="password" autocomplete="current-password" required><small class="field-error"></small></label>
      <div class="portal-login-help"><svg><use href="#i-shield"/></svg><span><strong>账号由管理员开通</strong><small>首次登录邀请和密码重置邮件发送到用户邮箱。</small></span></div>
    </form>`;
}

function portalHomeMarkup() {
  const profile = controlPlane.portalProfile;
  const user = profile.user;
  const entitlement = profile.entitlement;
  const clientEntries = universalClientFormats.map((clientId) => {
    const client = clientCatalog[clientId];
    if (!client) return "";
    return `<button type="button" data-client-import="${escapeHtml(clientId)}"><span><strong>${client.name}</strong><small>${client.platforms}</small></span><span>${escapeHtml(client.action)}</span></button>`;
  }).join("");
  return `
    <div class="portal-home">
      <div class="drawer-profile">
        <span class="avatar">${escapeHtml(user.initials)}</span>
        <div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}</small></div>
        <span class="status-badge good"><i></i>账号正常</span>
      </div>
      <div class="portal-entitlement">
        <p class="drawer-section-label">当前用户权益</p>
        <h3>${escapeHtml(user.name)} 的访问权益</h3>
        <p>流量和节点范围由管理员设置；通用订阅统一支持 Clash/Mihomo、Egern 与 sing-box。</p>
        <div class="entitlement-preview"><span><small>剩余流量</small><strong>${Math.max(0, entitlement.quotaGb - user.usedGb).toFixed(1)} GB</strong></span><span><small>节点范围</small><strong>${escapeHtml(scopeToLabel(entitlement.nodeScope))}</strong></span></div>
      </div>
      <p class="drawer-section-label">选择客户端</p>
      <div class="portal-client-list">
        ${clientEntries}
      </div>
      <p class="portal-note">用户中心根据当前账号权益准备客户端配置。用户无需查看或编辑底层协议参数。</p>
    </div>`;
}

function openPortal() {
  openDrawer({
    title: "用户中心",
    eyebrow: "登录预览",
    content: portalLoginMarkup(),
    saveLabel: "登录并查看"
  });
}

async function copyText(text, message = "内容已复制到剪贴板。") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  showToast("已复制", message);
}

async function rotateAdminUserSubscription(button) {
  const isReset = button.dataset.subscriptionConfigured === "true";
  if (
    isReset
    && !window.confirm("重新生成后，用户已经导入客户端的旧订阅地址会立即失效。确定继续吗？")
  ) return;

  const panel = button.closest("[data-user-subscription-panel]");
  const status = panel.querySelector("[data-user-subscription-status]");
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = isReset ? "正在重新生成…" : "正在生成…";
  try {
    const result = await api(
      `/api/users/${encodeURIComponent(button.dataset.userId)}/subscription/rotate`,
      { method: "POST" }
    );
    const qrReady = subscriptionQuick.reveal({
      panel,
      userId: button.dataset.userId,
      url: result.subscriptionUrl,
      session: subscriptionSession,
      qrRenderer: (container, value) => window.RayLinkSubscriptionQr?.render(container, value)
    });
    status.textContent = qrReady
      ? "新地址已生成并加密保存，之后可随时查看。"
      : "新地址已生成并加密保存，二维码暂不可用，请复制链接。";
    button.dataset.subscriptionConfigured = "true";
    button.textContent = "重新生成订阅地址";
    const user = users.find((item) => item.id === button.dataset.userId);
    if (user) user.subscription = { ...(user.subscription || {}), configured: true };
    renderUsers();
    showToast("订阅地址已生成", "新地址已加密保存，之后可随时查看。");
  } catch (error) {
    status.textContent = error.message;
    button.textContent = previousText;
    showToast("生成失败", error.message);
  } finally {
    button.disabled = false;
  }
}

async function downloadPortalConfig(format = "sing-box") {
  const requestedFormat = format;
  const filenames = {
    mihomo: "raylink-mihomo.yaml",
    egern: "raylink-egern.yaml",
    "egern-profile": "raylink-egern-profile.yaml",
    "sing-box": "raylink-sing-box.json"
  };
  try {
    const response = await fetch(`/api/portal/config/${requestedFormat}`);
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body?.error?.message || "配置生成失败");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filenames[requestedFormat] || "raylink-config";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast("配置已下载", "将配置导入对应客户端即可使用。");
  } catch (error) {
    showToast("下载失败", error.message);
  }
}

function validateDrawerForm(form) {
  let valid = true;
  form.querySelector("[data-form-error]")?.remove();
  form.querySelectorAll(".field-error").forEach((error) => error.classList.remove("visible"));
  form.querySelectorAll("[required]").forEach((input) => {
    if (input.checkValidity()) return;
    const error = input.closest(".field")?.querySelector(".field-error");
    if (error) {
      error.textContent = input.validity.typeMismatch
        ? "请输入有效的邮箱地址"
        : input.validity.rangeUnderflow
          ? `数值必须大于或等于 ${input.min}`
          : "此项不能为空";
      error.classList.add("visible");
    }
    valid = false;
  });
  if (!valid) form.querySelector(":invalid")?.focus();
  return valid;
}

function showDrawerFormError(form, error) {
  const fieldByCode = {
    INVALID_LISTEN: "listen",
    INVALID_PROTOCOL_PORT: "port",
    PROTOCOL_PORT_CONFLICT: "port",
    TLS_REQUIRED: "tlsMode",
    INVALID_TLS_MODE: "tlsMode",
    TLS_CERTIFICATE_REQUIRED: "certificatePath",
    REALITY_FIELDS_REQUIRED: "privateKey",
    INVALID_REALITY_PORT: "handshakePort",
    REALITY_NOT_SUPPORTED: "tlsMode",
    REALITY_UNAVAILABLE: "tlsMode",
    INVALID_TRANSPORT: "transportType",
    TRANSPORT_NOT_SUPPORTED: "transportType",
    TRANSPORT_TLS_REQUIRED: "transportType",
    QUIC_UNAVAILABLE: "transportType",
    PROTOCOL_OPTION_RESERVED: "options",
    INVALID_PROTOCOL_JSON: "options",
    HYSTERIA_BANDWIDTH_REQUIRED: "upMbps"
  };
  const input = form.elements[fieldByCode[error.code]];
  const field = input?.closest(".field");
  if (field) {
    let message = field.querySelector(".field-error");
    if (!message) {
      message = document.createElement("small");
      message.className = "field-error";
      field.appendChild(message);
    }
    message.textContent = error.message;
    message.classList.add("visible");
    input.focus();
    return;
  }
  let message = form.querySelector("[data-form-error]");
  if (!message) {
    message = document.createElement("p");
    message.className = "auth-error";
    message.dataset.formError = "";
    form.querySelector(".drawer-profile")?.after(message);
  }
  message.textContent = error.message;
  message.classList.add("visible");
}

async function saveUserForm(form) {
  const userId = form.dataset.userId;
  const name = form.elements.name.value.trim();
  const email = form.elements.email.value.trim();
  const payload = {
    name,
    email,
    quotaGb: Number(form.elements.quota.value),
    nodeScope: labelToScope(form.elements.nodeGroup.value),
    expiresAt: form.elements.expires.value,
    usedGb: Number(form.elements.usedGb.value),
    state: form.querySelector("[data-user-enabled]").classList.contains("on") ? "active" : "disabled",
    portalStatus: form.querySelector("[data-portal-enabled]").classList.contains("on") ? "active" : "invited"
  };
  if (form.elements.password?.value) payload.password = form.elements.password.value;
  const result = await api(userId ? `/api/users/${encodeURIComponent(userId)}` : "/api/users", {
    method: userId ? "PATCH" : "POST",
    body: JSON.stringify(payload)
  });
  // The write is committed. A failed refresh must not turn a retry into another POST.
  form.dataset.userId = result.id;
  try {
    await loadBootstrap();
  } catch {
    result.refreshWarning = "用户已保存，但列表刷新失败，请刷新页面查看最新状态。";
  }
  return result;
}

function showPasswordResetFieldError(input, message) {
  const field = input.closest(".field");
  const error = field?.querySelector(".field-error");
  if (error) {
    error.textContent = message;
    error.classList.add("visible");
  }
  input.focus();
}

async function resetUserPassword(button) {
  const form = button.closest("#user-drawer-form");
  const passwordInput = form?.elements.resetPassword;
  const confirmationInput = form?.elements.confirmResetPassword;
  if (!form || !passwordInput || !confirmationInput) return;
  form.querySelectorAll("[data-user-password-reset] .field-error").forEach((error) => {
    error.textContent = "";
    error.classList.remove("visible");
  });
  if (passwordInput.value.length < 8) {
    showPasswordResetFieldError(passwordInput, "用户中心密码至少需要 8 位");
    return;
  }
  if (passwordInput.value !== confirmationInput.value) {
    showPasswordResetFieldError(confirmationInput, "两次输入的密码不一致");
    return;
  }

  const previousLabel = button.textContent;
  button.disabled = true;
  button.textContent = "正在重置…";
  try {
    const result = await api(
      `/api/users/${encodeURIComponent(button.dataset.userId)}/password/reset`,
      {
        method: "POST",
        body: JSON.stringify({ password: passwordInput.value })
      }
    );
    passwordInput.value = "";
    confirmationInput.value = "";
    showToast(
      "密码重置成功",
      result.sessionsRevoked
        ? `已注销 ${result.sessionsRevoked} 个用户中心会话，新密码立即生效。`
        : "新密码已生效，用户可立即登录。"
    );
  } catch (error) {
    showPasswordResetFieldError(passwordInput, error.message);
    showToast("密码重置失败", error.message);
  } finally {
    button.disabled = false;
    button.textContent = previousLabel;
  }
}

async function saveHostForm(form) {
  const hostId = form.dataset.hostId;
  await api(`/api/hosts/${encodeURIComponent(hostId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: form.elements.hostname.value.trim(),
      address: form.elements.address.value.trim(),
      region: form.elements.region.value.trim()
    })
  });
  await loadBootstrap();
}

async function saveNewHostForm(form) {
  return api("/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: form.elements.hostname.value.trim(),
      address: form.elements.address.value.trim(),
      region: form.elements.region.value.trim()
    })
  });
}

async function saveProtocolForm(form) {
  const host = controlPlane.hosts.find((item) => item.id === form.dataset.hostId);
  const existing = host?.protocols?.find((item) => item.type === form.dataset.protocolType);
  const catalog = (host?.protocolCatalog || controlPlane.protocolCatalog)
    .find((item) => item.type === form.dataset.protocolType);
  if (
    existing
    && !existing.enabled
    && catalog?.activationPolicy?.group !== "advanced"
    && form.querySelector("[data-protocol-enabled]").classList.contains("on")
  ) {
    const phases = ["配置中…", "待发布…", "正在部署…", "检查端口…"];
    let phase = 0;
    elements.drawerSave.textContent = phases[phase];
    const phaseTimer = setInterval(() => {
      phase = Math.min(phase + 1, phases.length - 1);
      elements.drawerSave.textContent = phases[phase];
    }, 900);
    try {
      const result = await api(
        `/api/hosts/${encodeURIComponent(form.dataset.hostId)}/protocols/${encodeURIComponent(form.dataset.protocolType)}/activate`,
        { method: "POST" }
      );
      await loadBootstrap();
      return { ...result, oneClick: true };
    } finally {
      clearInterval(phaseTimer);
    }
  }
  let advancedOptions;
  try {
    advancedOptions = JSON.parse(form.elements.options.value || "{}");
  } catch {
    const error = new Error("附加 JSON 不是有效对象");
    error.code = "INVALID_PROTOCOL_JSON";
    throw error;
  }
  if (!advancedOptions || Array.isArray(advancedOptions) || typeof advancedOptions !== "object") {
    const error = new Error("附加 JSON 必须是对象");
    error.code = "INVALID_PROTOCOL_JSON";
    throw error;
  }
  const protocol = catalog;
  const fieldValue = (name, fallback = "") => form.elements[name]?.value?.trim() ?? fallback;
  if (protocol.type === "hysteria") {
    advancedOptions = {
      ...advancedOptions,
      up_mbps: Number(fieldValue("upMbps", "100")),
      down_mbps: Number(fieldValue("downMbps", "100"))
    };
  }
  await api(`/api/hosts/${encodeURIComponent(form.dataset.hostId)}/protocols/${encodeURIComponent(form.dataset.protocolType)}`, {
    method: "PATCH",
    body: JSON.stringify({
      enabled: form.querySelector("[data-protocol-enabled]").classList.contains("on"),
      listen: fieldValue("listen", "::"),
      port: protocol.portless ? null : Number(fieldValue("port")),
      tls: {
        mode: fieldValue("tlsMode", "none"),
        serverName: fieldValue("serverName"),
        certificatePath: fieldValue("certificatePath"),
        keyPath: fieldValue("keyPath"),
        handshakeServer: fieldValue("handshakeServer"),
        handshakePort: Number(fieldValue("handshakePort", "443")),
        privateKey: fieldValue("privateKey"),
        publicKey: fieldValue("publicKey"),
        shortId: fieldValue("shortId"),
        acmeEmail: fieldValue("acmeEmail"),
        acmeDataDirectory: fieldValue("acmeDataDirectory", "/var/lib/raylink/acme")
      },
      transport: {
        type: fieldValue("transportType", "none"),
        path: fieldValue("transportPath"),
        serviceName: fieldValue("transportServiceName")
      },
      options: advancedOptions
    })
  });
  await loadBootstrap();
  return { oneClick: false };
}

async function saveDrawer() {
  const form = elements.drawerContent.querySelector("form");
  if (!form) {
    closeDrawer();
    return;
  }
  if (!validateDrawerForm(form)) return;

  if (form.id === "portal-login-form") {
    const email = form.elements.portalEmail.value.trim();
    const password = form.elements.portalPassword.value;
    try {
      controlPlane.portalProfile = await api("/api/portal/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
    } catch (error) {
      const passwordError = form.elements.portalPassword.closest(".field").querySelector(".field-error");
      passwordError.textContent = error.message;
      passwordError.classList.add("visible");
      form.elements.portalPassword.focus();
      return;
    }
    const user = controlPlane.portalProfile.user;
    currentPortalUserEmail = user.email;
    elements.drawerEyebrow.textContent = "用户中心预览";
    elements.drawerTitle.textContent = "我的服务";
    elements.drawerContent.innerHTML = portalHomeMarkup();
    elements.drawerSave.textContent = "关闭预览";
    showToast("登录成功", `已进入 ${user.name} 的用户中心。`);
    return;
  }

  elements.drawerSave.disabled = true;
  const previousLabel = elements.drawerSave.textContent;
  elements.drawerSave.textContent = "保存中…";
  let userSaveResult = null;
  let protocolSaveResult = null;
  try {
    if (form.id === "user-drawer-form") userSaveResult = await saveUserForm(form);
    if (form.id === "host-drawer-form") await saveHostForm(form);
    if (form.id === "new-host-drawer-form") {
      const created = await saveNewHostForm(form);
      await loadBootstrap();
      elements.drawerEyebrow.textContent = "一次性接入";
      elements.drawerTitle.textContent = "安装 RayLink Node";
      elements.drawerContent.innerHTML = enrollmentResultMarkup(created);
      elements.drawerSave.textContent = "完成";
      elements.drawerSave.disabled = false;
      showToast("主机已创建", "请在新 VPS 上执行一次性安装命令。");
      return;
    }
    if (form.id === "protocol-drawer-form") protocolSaveResult = await saveProtocolForm(form);
  } catch (error) {
    let errorForm = form;
    if (form?.id === "protocol-drawer-form") {
      const hostId = form.dataset.hostId;
      const protocolType = form.dataset.protocolType;
      try {
        await loadBootstrap();
        elements.drawerContent.innerHTML = protocolDrawerMarkup(hostId, protocolType);
        errorForm = elements.drawerContent.querySelector("#protocol-drawer-form");
      } catch {}
    }
    if (errorForm) showDrawerFormError(errorForm, error);
    showToast("保存失败", error.message);
    elements.drawerSave.disabled = false;
    elements.drawerSave.textContent = previousLabel;
    return;
  }

  if (
    form.id === "user-drawer-form"
    && previousLabel.includes("创建")
    && userSaveResult?.id
  ) {
    const createdUser = users.find((user) => user.id === userSaveResult.id);
    if (createdUser) {
      elements.drawerEyebrow.textContent = "用户详情";
      elements.drawerTitle.textContent = createdUser.name;
      elements.drawerContent.innerHTML = userDrawerMarkup(createdUser);
      elements.drawerSave.textContent = "保存更改";
      elements.drawerSave.disabled = false;
      showToast(
        userSaveResult.runtimeSync?.status === "pending" ? "用户已创建，等待应用" : "用户已创建",
        [
          userSaveResult.runtimeSync?.status === "pending"
            ? userSaveResult.runtimeSync.message
            : "可立即复制用户中心入口，并生成订阅链接或二维码。",
          userSaveResult.refreshWarning
        ].filter(Boolean).join("；")
      );
      return;
    }
  }

  const activatedProtocol = protocolSaveResult?.profile
    ? controlPlane.protocolCatalog.find((item) => item.type === protocolSaveResult.profile.type)
    : null;
  const activationIsPrivate = activatedProtocol?.activationPolicy?.exposure === "private";
  const message = userSaveResult?.runtimeSync?.status === "pending"
    ? userSaveResult.runtimeSync.message
    : form?.id === "host-drawer-form"
      ? "Runtime 主机已更新，用户配置将使用新的公网地址。"
    : form?.id === "protocol-drawer-form"
      ? protocolSaveResult?.oneClick
        ? protocolSaveResult.activation?.state === "deploying"
          ? activationIsPrivate
            ? "协议已完成配置并发送到远程节点，节点确认后仅在该主机本机提供服务。"
            : "协议已完成配置并发送到远程节点，节点确认监听后会自动进入用户订阅。"
          : activationIsPrivate
            ? "协议已完成配置、校验和发布，仅可由该主机本机访问。"
            : "协议已完成配置、校验和发布，并已自动进入用户订阅。"
        : "协议草稿已保存，请在配置发布页校验并发布。"
    : form?.id === "user-drawer-form" && previousLabel.includes("创建")
      ? "用户已创建，独立权益已经保存。"
      : previousLabel.includes("添加")
        ? "主机连接信息已通过本地校验。"
        : "更改已经写入当前草稿。";
  closeDrawer();
  showToast(
    protocolSaveResult?.oneClick
      ? protocolSaveResult.activation?.state === "deploying" ? "正在远程部署" : "协议已启用"
      : userSaveResult?.runtimeSync?.status === "pending" ? "已保存，等待应用" : "已保存",
    [message, userSaveResult?.refreshWarning].filter(Boolean).join("；")
  );
  elements.drawerSave.disabled = false;
}

function handleSwitch(button) {
  const enabled = button.classList.toggle("on");
  button.setAttribute("aria-checked", String(enabled));
}

async function publishConfig() {
  if (publishInProgress) return;
  publishInProgress = true;
  const button = document.querySelector("#publish-config");
  const items = [...document.querySelectorAll("#publish-trail li")];
  const statusBadge = document.querySelector(".release-header .status-badge");
  button.disabled = true;
  button.innerHTML = `${icon("refresh")} 正在校验`;
  statusBadge.className = "status-badge warning";
  statusBadge.innerHTML = "<i></i>发布中";

  items[0].className = "done";
  items[0].querySelector("span").innerHTML = icon("check");
  try {
    const preview = await api("/api/deployments/preview", { method: "POST" });
    items[1].className = "done";
    items[1].querySelector("span").innerHTML = icon("check");
    items[2].className = "current";
    button.innerHTML = `${icon("refresh")} 写入快照`;
    showToast("校验完成", `${preview.eligibleUsers} 位有效用户，${preview.inboundCount} 个入站。`);

    const deployment = await api("/api/deployments", { method: "POST" });
    items.forEach((item) => {
      item.className = "done";
      item.querySelector("span").innerHTML = icon("check");
    });
    button.innerHTML = `${icon("check")} 已发布`;
    statusBadge.className = "status-badge good";
    statusBadge.innerHTML = "<i></i>已生效";
    document.querySelectorAll(".release-version").forEach((element) => {
      element.textContent = deployment.version;
    });
    await loadBootstrap();
    showToast("配置已生效", `${deployment.eligibleUsers} 位用户已写入 sing-box 配置。`);
  } catch (error) {
    button.innerHTML = `${icon("terminal")} 重试发布`;
    statusBadge.className = "status-badge warning";
    statusBadge.innerHTML = "<i></i>发布失败";
    showToast("发布失败", error.message);
  } finally {
    button.disabled = false;
    publishInProgress = false;
  }
}

async function rollbackConfig() {
  const button = document.querySelector("#rollback-config");
  const deploymentId = button.dataset.deploymentId;
  if (!deploymentId || publishInProgress) return;
  publishInProgress = true;
  button.disabled = true;
  button.innerHTML = `${icon("refresh")} 回滚中`;
  try {
    const deployment = await api(`/api/deployments/${encodeURIComponent(deploymentId)}/rollback`, {
      method: "POST"
    });
    await loadBootstrap();
    showToast("回滚已生效", `已从历史快照创建 ${deployment.version}。`);
  } catch (error) {
    showToast("回滚失败", error.message);
  } finally {
    publishInProgress = false;
    button.innerHTML = `${icon("rollback")} 回滚上一版本`;
    button.disabled = !button.dataset.deploymentId;
  }
}

async function installSingBox() {
  const button = document.querySelector("#install-sing-box");
  if (!button || button.disabled) return;
  button.disabled = true;
  button.innerHTML = `${icon("refresh")} 正在安装`;
  try {
    const installation = await api("/api/runtime/install", { method: "POST" });
    await loadBootstrap();
    if (elements.drawer.classList.contains("open")) openHost("local");
    showToast("sing-box 已安装", `当前版本 ${installation.version}，可以开始配置协议。`);
  } catch (error) {
    showToast("安装失败", error.message);
    button.disabled = false;
    button.innerHTML = `${icon("terminal")} 重试安装`;
  }
}

async function checkRuntimeUpdate() {
  const button = document.querySelector("[data-check-runtime-update]");
  if (button) {
    button.disabled = true;
    button.innerHTML = `${icon("refresh")} 正在检查`;
  }
  try {
    controlPlane.runtimeUpdate = await api("/api/runtime/update");
    renderSystem();
    const update = controlPlane.runtimeUpdate;
    showToast(
      update.updateAvailable ? "发现 sing-box 更新" : "版本检查完成",
      update.blockedReason
        || (update.updateAvailable
          ? `稳定版 ${update.latestVersion} 可以安全升级。`
          : "当前已是最新兼容稳定版。")
    );
  } catch (error) {
    showToast("检查更新失败", error.message);
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = `${icon("refresh")} 检查更新`;
    }
  }
}

async function upgradeLocalRuntime() {
  const button = document.querySelector("#upgrade-local-runtime");
  if (!button || button.hidden || button.disabled) return;
  if (!window.confirm(
    "升级会重启本机 sing-box。RayLink 控制面、用户和订阅不会中断，但连接到这台 Runtime 的现有会话可能短暂重连。确认继续？"
  )) return;
  button.disabled = true;
  button.innerHTML = `${icon("refresh")} 正在安全升级`;
  try {
    const result = await api("/api/runtime/upgrade", { method: "POST" });
    await loadBootstrap();
    showToast(
      "sing-box 升级完成",
      `已从 ${result.previousVersion} 升级到 ${result.version}，现有配置与服务检查通过。`
    );
  } catch (error) {
    showToast(
      error.code === "RUNTIME_UPGRADE_ROLLED_BACK" ? "升级失败，已自动回滚" : "升级失败",
      error.message
    );
  } finally {
    button.disabled = false;
    renderSystem();
  }
}

async function upgradeRemoteRuntime(hostId) {
  const button = document.querySelector(`[data-upgrade-host="${CSS.escape(hostId)}"]`);
  if (!window.confirm(
    "升级会重启该主机的 sing-box。其他 Runtime 和 RayLink 控制面继续工作，但当前连接到该主机的会话可能短暂重连。确认继续？"
  )) return;
  if (button) {
    button.disabled = true;
    button.innerHTML = `${icon("refresh")} 正在加入升级队列`;
  }
  try {
    const queued = await api(`/api/hosts/${encodeURIComponent(hostId)}/runtime-upgrade`, {
      method: "POST"
    });
    await loadBootstrap();
    openHost(hostId);
    showToast("远程升级已下发", `节点将升级到 ${queued.targetVersion}，失败时自动恢复旧版本。`);
  } catch (error) {
    showToast("远程升级失败", error.message);
    if (button) button.disabled = false;
  }
}

async function measureHostProtocolLatency(hostId, button) {
  if (button?.disabled) return;
  if (button) {
    button.disabled = true;
    button.innerHTML = `${icon("refresh")} 正在测试协议连接`;
  }
  try {
    const measured = await api(
      `/api/hosts/${encodeURIComponent(hostId)}/protocols/latency`,
      { method: "POST" }
    );
    await loadBootstrap();
    if (elements.drawer.classList.contains("open")) openHost(hostId);
    const available = measured.results.filter((result) => result.status === "available").length;
    showToast(
      "协议连接测试完成",
      `${available}/${measured.results.length} 个公网协议可用，结果已更新到主机列表。`
    );
  } catch (error) {
    showToast("协议连接测试失败", error.message);
    if (button) {
      button.disabled = false;
      button.innerHTML = `${icon("refresh")} 重新测试协议连接`;
    }
  }
}

async function generateRealityKeypair(form) {
  const button = form.querySelector("[data-generate-reality]");
  button.disabled = true;
  button.textContent = "生成中…";
  try {
    const keypair = await api("/api/runtime/reality-keypair", { method: "POST" });
    form.elements.privateKey.value = keypair.privateKey;
    form.elements.publicKey.value = keypair.publicKey;
    if (keypair.shortId) form.elements.shortId.value = keypair.shortId;
    form.elements.tlsMode.value = "reality";
    showToast("Reality 密钥已生成", "密钥只保存在当前协议草稿中，保存后写入数据库。");
  } catch (error) {
    showToast("生成失败", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "重新生成";
  }
}

function selectWorkspaceTab(kind, value) {
  if (kind === "system" && ["mcp", "access"].includes(value) && controlPlane.currentAdmin?.role !== "owner") value = "hosts";
  const buttons = [...document.querySelectorAll(`[data-${kind}-tab]`)];
  buttons.forEach((button) => {
    const active = button.dataset[`${kind}Tab`] === value;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });

  const panels = [...document.querySelectorAll(`[data-${kind}-panel]`)];
  panels.forEach((panel) => {
    panel.hidden = panel.dataset[`${kind}Panel`] !== value;
  });

}

function openAdvancedConfig() {
  const preview = document.querySelector("#managed-config-preview")?.textContent || "{}";
  openDrawer({
    title: "受管配置摘要",
    eyebrow: "配置 JSON",
    content: `
      <div class="advanced-drawer">
        <div class="notice-card">
          <span>${icon("shield")}</span>
          <div><strong>受管配置只读</strong><p>这里展示 RayLink 管理的核心字段。用户凭据、协议监听和发布字段由系统生成，请在对应工作区修改资源。</p></div>
        </div>
        <pre class="advanced-preview"><code>${escapeHtml(preview)}</code></pre>
        <p class="field-hint">发布前仍会执行 sing-box check，并保存不可变快照。</p>
      </div>`,
    saveLabel: "关闭"
  });
}

document.addEventListener("click", async (event) => {
  const logoutButton = event.target.closest("[data-logout]");
  if (logoutButton) {
    await logoutControlPlane(logoutButton);
    return;
  }

  if (event.target.closest("#profile-menu-trigger")) {
    setProfileMenu(elements.profileMenu.hidden);
    if (!elements.profileMenu.hidden) elements.profileMenu.querySelector("[data-logout]").focus();
    return;
  }

  if (!event.target.closest(".profile-menu-wrap")) setProfileMenu(false);

  if (event.target.closest("[data-open-runtime-updates]")) {
    navigate("system");
    selectWorkspaceTab("system", "maintenance");
    return;
  }

  const viewButton = event.target.closest("[data-view-target]");
  if (viewButton) {
    navigate(viewButton.dataset.viewTarget);
    return;
  }

  const userButton = event.target.closest("[data-user]");
  if (userButton) {
    openUser(userButton.dataset.user);
    return;
  }

  const hostButton = event.target.closest("[data-open-host]");
  if (hostButton) {
    openHost(hostButton.dataset.openHost);
    return;
  }

  if (event.target.closest("[data-new-host]")) {
    openNewHost();
    return;
  }

  const latencyButton = event.target.closest("[data-measure-host-latency]");
  if (latencyButton) {
    await measureHostProtocolLatency(
      latencyButton.dataset.measureHostLatency,
      latencyButton
    );
    return;
  }

  const reissueHostButton = event.target.closest("[data-reissue-host]");
  if (reissueHostButton) {
    try {
      const created = await api(
        `/api/hosts/${encodeURIComponent(reissueHostButton.dataset.reissueHost)}/enrollment-token`,
        { method: "POST" }
      );
      await loadBootstrap();
      elements.drawerEyebrow.textContent = "一次性接入";
      elements.drawerTitle.textContent = "安装 RayLink Node";
      elements.drawerContent.innerHTML = enrollmentResultMarkup(created);
      elements.drawerSave.textContent = "完成";
      showToast("接入命令已更新", "旧令牌已经失效，请使用新命令。");
    } catch (error) {
      showToast("生成失败", error.message);
    }
    return;
  }

  const protocolButton = event.target.closest("[data-host-protocol]");
  if (protocolButton) {
    openProtocol(protocolButton.dataset.hostId, protocolButton.dataset.hostProtocol);
    return;
  }

  const policyTab = event.target.closest("[data-policy-tab]");
  if (policyTab) {
    selectWorkspaceTab("policy", policyTab.dataset.policyTab);
    return;
  }

  const deleteRoutingRule = event.target.closest("[data-routing-rule-delete]");
  if (deleteRoutingRule) {
    deleteRoutingRule.disabled = true;
    try {
      await persistRoutingPolicy(
        {
          ...controlPlane.routingPolicy,
          rules: controlPlane.routingPolicy.rules.filter(
            (rule) => rule.id !== deleteRoutingRule.dataset.routingRuleDelete
          )
        },
        "规则已删除，订阅配置会立即使用新的规则顺序。"
      );
    } catch (error) {
      deleteRoutingRule.disabled = false;
      showToast("删除失败", error.message);
    }
    return;
  }

  const systemTab = event.target.closest("[data-system-tab]");
  if (systemTab) {
    selectWorkspaceTab("system", systemTab.dataset.systemTab);
    if (systemTab.dataset.systemTab === "readiness" && !controlPlane.readiness) {
      await refreshReadiness(document.querySelector("[data-refresh-readiness]"));
    }
    if (systemTab.dataset.systemTab === "mcp") await loadMcpAccess();
    return;
  }

  if (event.target.closest("[data-refresh-mcp]")) { await loadMcpAccess(); return; }
  const mcpPreset = event.target.closest("[data-mcp-preset]");
  if (mcpPreset) { applyMcpPreset(mcpPreset.dataset.mcpPreset); return; }
  if (event.target.closest("[data-dismiss-mcp]")) {
    clearMcpSecret();
    setText("#mcp-access-status", "一次性显示已关闭。令牌仍然有效，无法再次查看；不再使用时请撤销。");
    document.querySelector("#mcp-create-submit").focus();
    return;
  }
  const copyMcp = event.target.closest("[data-copy-mcp]");
  if (copyMcp) {
    if (controlPlane.currentAdmin?.role !== "owner" || !mcpAccess.issued) return;
    const value = document.querySelector(copyMcp.dataset.copyMcp === "config" ? "#mcp-issued-config" : "#mcp-issued-token").value;
    if (value) await copyText(value, "连接凭据已复制，请仅粘贴到受信任的 Agent 客户端。");
    return;
  }
  const revokeMcp = event.target.closest("[data-revoke-mcp]");
  if (revokeMcp) { await revokeMcpCredential(revokeMcp); return; }

  const readinessButton = event.target.closest("[data-refresh-readiness], [data-export-readiness]");
  if (readinessButton) {
    await refreshReadiness(readinessButton, readinessButton.hasAttribute("data-export-readiness"));
    return;
  }
  const readinessTarget = event.target.closest("[data-readiness-target]");
  if (readinessTarget) {
    const target = readinessTarget.dataset.readinessTarget;
    if (target === "routing") {
      navigate("policies");
    } else {
      selectWorkspaceTab("system", target);
    }
    return;
  }

  if (event.target.closest("[data-advanced-json]")) {
    openAdvancedConfig();
    return;
  }

  if (event.target.closest("[data-refresh-runtime]")) {
    try {
      await loadBootstrap();
      showToast("状态已刷新", "已重新读取 Runtime 与安装状态。");
    } catch (error) {
      showToast("刷新失败", error.message);
    }
    return;
  }

  const hostDiagnosticsButton = event.target.closest("[data-refresh-host-diagnostics]");
  if (hostDiagnosticsButton) {
    const hostId = hostDiagnosticsButton.dataset.refreshHostDiagnostics;
    try {
      await loadBootstrap();
      openHost(hostId);
      showToast("主机诊断已刷新", "已重新读取主机、Runtime、协议、用户和发布状态。");
    } catch (error) {
      showToast("诊断刷新失败", error.message);
    }
    return;
  }

  if (event.target.closest("[data-check-runtime-update]")) {
    await checkRuntimeUpdate();
    return;
  }

  if (event.target.closest("[data-create-backup]")) {
    await createDatabaseBackup();
    return;
  }

  if (event.target.closest("#upgrade-local-runtime")) {
    await upgradeLocalRuntime();
    return;
  }

  const hostUpgradeButton = event.target.closest("[data-upgrade-host]");
  if (hostUpgradeButton) {
    await upgradeRemoteRuntime(hostUpgradeButton.dataset.upgradeHost);
    return;
  }

  const saveAdminButton = event.target.closest("[data-save-admin]");
  if (saveAdminButton) {
    await saveAdministrator(saveAdminButton.dataset.saveAdmin);
    return;
  }

  if (event.target.closest("#install-sing-box")) {
    await installSingBox();
    return;
  }

  const realityButton = event.target.closest("[data-generate-reality]");
  if (realityButton) {
    await generateRealityKeypair(realityButton.closest("form"));
    return;
  }

  if (event.target.closest("[data-new-user]")) {
    openNewUser();
    return;
  }

  if (event.target.closest("[data-open-portal]")) {
    openPortal();
    return;
  }

  const userSubscriptionQuick = event.target.closest("[data-user-subscription-quick]");
  if (userSubscriptionQuick) {
    openUserSubscriptionQuick(userSubscriptionQuick.dataset.userSubscriptionQuick);
    return;
  }

  const userSubscriptionButton = event.target.closest("[data-user-subscription-action]");
  if (userSubscriptionButton) {
    await rotateAdminUserSubscription(userSubscriptionButton);
    return;
  }

  const resetUserPasswordButton = event.target.closest("[data-reset-user-password]");
  if (resetUserPasswordButton) {
    await resetUserPassword(resetUserPasswordButton);
    return;
  }

  const clientImport = event.target.closest("[data-client-import]");
  if (clientImport) {
    downloadPortalConfig(clientImport.dataset.clientImport);
    return;
  }

  if (event.target.closest("[data-send-invite]")) {
    const form = event.target.closest("#user-drawer-form");
    const user = users.find((item) => item.email === form?.dataset.originalEmail);
    if (user) {
      user.portalStatus = "invited";
      form.querySelector("[data-login-status]").textContent = "登录邀请已发送";
    }
    showToast("登录邀请已发送", "用户将通过邮箱完成首次登录或重置密码。");
    return;
  }

  const switchButton = event.target.closest(".switch");
  if (switchButton) {
    handleSwitch(switchButton);
    return;
  }

  const copyButton = event.target.closest("[data-copy-target]");
  if (copyButton) {
    const target = document.getElementById(copyButton.dataset.copyTarget);
    copyText(
      (target.value || target.textContent).trim(),
      target.id.includes("subscription")
        ? "订阅地址已复制，请通过安全渠道交付。"
        : "用户中心入口已复制到剪贴板。"
    );
    return;
  }

  const filter = event.target.closest("[data-user-filter]");
  if (filter) {
    activeUserFilter = filter.dataset.userFilter;
    document.querySelectorAll("[data-user-filter]").forEach((button) => button.classList.toggle("active", button === filter));
    renderUsers();
    return;
  }

});

elements.userSearch.addEventListener("input", renderUsers);
elements.menuToggle.addEventListener("click", () => {
  const isOpen = elements.rail.classList.toggle("open");
  elements.menuToggle.setAttribute("aria-expanded", String(isOpen));
  elements.rail.toggleAttribute("inert", !isOpen && window.innerWidth <= 920);
});
elements.drawerClose.addEventListener("click", closeDrawer);
elements.drawerCancel.addEventListener("click", closeDrawer);
elements.drawerScrim.addEventListener("click", closeDrawer);
elements.drawerSave.addEventListener("click", saveDrawer);
document.querySelector("#certificate-settings-form").addEventListener("submit", saveCertificateSettings);
document.querySelector("#admin-create-form")?.addEventListener("submit", createAdministrator);
document.querySelector("#mcp-create-form").addEventListener("submit", createMcpCredential);
document.querySelector("#mcp-scope-list").addEventListener("change", () => {
  document.querySelectorAll("[data-mcp-preset]").forEach((button) => button.setAttribute("aria-pressed", "false"));
});
document.querySelector("#routing-mode-form")?.addEventListener("submit", saveRoutingMode);
document.querySelector("#routing-rule-form")?.addEventListener("submit", addRoutingRule);
document.querySelector("#routing-diagnose-form")?.addEventListener("submit", diagnoseRouting);

document.querySelector("#publish-config").addEventListener("click", publishConfig);
document.querySelector("#rollback-config").addEventListener("click", rollbackConfig);

document.querySelector("#global-search").addEventListener("click", () => {
  navigate("users");
  setTimeout(() => elements.userSearch.focus(), 120);
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    navigate("users");
    setTimeout(() => elements.userSearch.focus(), 120);
  }
  if (event.key === "Escape") {
    if (!elements.profileMenu.hidden) {
      setProfileMenu(false);
      elements.profileMenuTrigger.focus();
    } else if (elements.drawer.classList.contains("open")) closeDrawer();
    else {
      elements.rail.classList.remove("open");
      elements.rail.toggleAttribute("inert", window.innerWidth <= 920);
      elements.menuToggle.setAttribute("aria-expanded", "false");
    }
  }
  if (event.key === "Tab" && elements.drawer.classList.contains("open")) {
    const focusable = [...elements.drawer.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((node) => !node.disabled);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

window.addEventListener("popstate", () => {
  const route = location.hash.replace(/^#\//, "") || "dashboard";
  navigate(route, false);
});

function syncResponsiveNavigation() {
  const compact = window.innerWidth <= 920;
  if (!compact) elements.rail.classList.remove("open");
  elements.rail.toggleAttribute("inert", compact && !elements.rail.classList.contains("open"));
  elements.menuToggle.setAttribute("aria-expanded", String(elements.rail.classList.contains("open")));
}

window.addEventListener("resize", syncResponsiveNavigation);

async function enterControlPlane() {
  await loadBootstrap();
  elements.authScreen.hidden = true;
  elements.appShell.hidden = false;
  elements.mobileNav.hidden = false;
  syncResponsiveNavigation();
  const initialRoute = location.hash.replace(/^#\//, "") || "dashboard";
  navigate(initialRoute, false);
  if (!bootstrapRefreshTimer) {
    bootstrapRefreshTimer = setInterval(async () => {
      if (document.hidden || bootstrapRefreshInFlight) return;
      bootstrapRefreshInFlight = true;
      try {
        await loadBootstrap();
      } catch (error) {
        if (error.status === 401) showAdminLogin();
      } finally {
        bootstrapRefreshInFlight = false;
      }
    }, 10_000);
  }
}

elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.authError.textContent = "";
  const submit = elements.authForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "登录中…";
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: elements.authForm.elements.username.value.trim(),
        password: elements.authForm.elements.password.value
      })
    });
    await enterControlPlane();
  } catch (error) {
    elements.authError.textContent = error.message;
    elements.authForm.elements.password.focus();
  } finally {
    submit.disabled = false;
    submit.textContent = "登录";
  }
});

enterControlPlane().catch((error) => {
  if (error.status !== 401) elements.authError.textContent = `无法连接控制面：${error.message}`;
  elements.authScreen.hidden = false;
  elements.appShell.hidden = true;
});
