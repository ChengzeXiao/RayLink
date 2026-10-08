const users = [];
const subscriptionSession = window.RayLinkSubscriptionSession;
const subscriptionQuick = window.RayLinkSubscriptionQuick;
const protocolHealth = window.RayLinkProtocolHealth;
let bootstrapRefreshTimer = null;
let bootstrapRefreshInFlight = false;
let bootstrapRefreshPromise = null;
let bootstrapReadPromise = null;
let aiDiagnosticsLoading = false;
let aiEgressDirty = false;
let aiEgressSaving = false;
let aiEgressError = "";
let routingPolicySaving = false;
let routingDiagnosisLoading = false;
const controlPlaneConnection = { disconnected: false, failures: 0, active: false, generation: 0, controller: null };
const requiredNodeAgentVersion = "0.9.0";

const clientCatalog = {
  mihomo: { name: "Clash / Mihomo", platforms: "Windows / macOS / Android", action: "导入订阅" },
  "mihomo-modern": { name: "Mihomo 共享测速", platforms: "内核 1.19.1+ · 减少重复探测", action: "下载配置" },
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
const universalClientFormats = Object.freeze(["mihomo", "mihomo-modern", "loon", "egern-profile", "egern", "sing-box"]);

const accountSummary = { totalUsers: 0 };

const controlPlane = {
  currentAdmin: null,
  usagePeriod: null,
  hosts: [],
  runtime: null,
  runtimePreview: null,
  installation: null,
  runtimeSetup: null,
  tlsRenewal: null,
  bbr: null,
  systemUpdate: null,
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
  routingPolicy: { mode: "smart", unknownDomain: "resolve-geoip", aiSelection: "fallback", rules: [] },
  routingRuleSets: null,
  aiDomainRules: null,
  aiUpstream: null,
  aiEgress: null,
  portalProfile: null
};

const mcpAccess = { tokens: [], scopes: [], endpoint: "", issued: null, loading: false, creating: false, generation: 0 };
const provisioning = { jobs: [], loading: false, timer: null, drawerJobId: null, generation: 0 };
const runtimeSetupRequest = { running: false, error: "" };
let certificateSyncRunning = false;
const systemUpdateRequest = { checking: false, upgrading: false, error: "" };

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

function nodeVersionSupports(version, minimumVersion) {
  return /^\d+\.\d+\.\d+$/.test(String(version || "")) && !versionIsOlder(version, minimumVersion);
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
    usagePeriod: user.usagePeriod || data.usagePeriod || null,
    nodeScope: user.nodeScope,
    expires: user.expiresAt,
    subscription: user.subscription
  })));
  accountSummary.totalUsers = users.length;
  controlPlane.currentAdmin = data.currentAdmin;
  controlPlane.usagePeriod = data.usagePeriod || null;
  controlPlane.provisioning = data.provisioning || null;
  if (!canProvision() || (previousAdminId && previousAdminId !== data.currentAdmin.id)) clearProvisioning();
  document.querySelector("#provisioning-history").hidden = !canProvision();
  document.querySelectorAll("[data-new-host]").forEach((button) => { button.hidden = !canProvision(); });
  controlPlane.hosts = data.hosts;
  controlPlane.runtime = data.runtime;
  controlPlane.runtimePreview = data.runtimePreview;
  controlPlane.installation = data.installation;
  controlPlane.runtimeSetup = data.runtimeSetup || null;
  controlPlane.tlsRenewal = data.tlsRenewal || null;
  if (["running", "succeeded"].includes(controlPlane.runtimeSetup?.status)) runtimeSetupRequest.error = "";
  controlPlane.bbr = data.bbr || null;
  controlPlane.systemUpdate = data.systemUpdate || null;
  if (["queued", "running", "succeeded"].includes(controlPlane.systemUpdate?.task?.status)) systemUpdateRequest.error = "";
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
  controlPlane.nodeDomains = data.nodeDomains || null;
  controlPlane.aiUpstream = data.aiUpstream || null;
  controlPlane.aiEgress = data.aiEgress || null;
  controlPlane.aiDomainRules = data.aiDomainRules || null;
  controlPlane.routingRuleSets = data.routingRuleSets || null;
  controlPlane.routingPolicy = data.routingPolicy || {
    mode: "smart",
    unknownDomain: "resolve-geoip",
    aiSelection: "fallback",
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
  renderRuntimeSetup();
  renderSystemUpdate();
}

async function loadBootstrap({ share = false } = {}) {
  const generation = controlPlaneConnection.generation;
  const earlierRead = bootstrapReadPromise;
  if (earlierRead) {
    if (share) return earlierRead;
    // A refresh after a committed write must not reuse a snapshot requested before that write.
    await earlierRead.catch(() => {});
    if (generation !== controlPlaneConnection.generation) {
      throw Object.assign(new Error("登录状态已变化，请重新读取页面。"), { name: "AbortError" });
    }
    if (bootstrapReadPromise && bootstrapReadPromise !== earlierRead) return bootstrapReadPromise;
  }
  const controller = new AbortController();
  controlPlaneConnection.controller = controller;
  const request = api("/api/bootstrap", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) }).then((data) => {
    if (generation === controlPlaneConnection.generation) applyBootstrap(data);
    return data;
  });
  bootstrapReadPromise = request;
  try { return await request; }
  finally {
    if (bootstrapReadPromise === request) bootstrapReadPromise = null;
    if (controlPlaneConnection.controller === controller) controlPlaneConnection.controller = null;
  }
}

function renderRuntime() {
  const runtime = controlPlane.runtime;
  if (!runtime) return;
  const railStatus = document.querySelector(".rail-status");
  const activeDeployment = controlPlane.deployments.find((deployment) => deployment.status === "active");
  const deploymentVersion = activeDeployment?.version || "尚未发布";
  const healthy = runtime.mode === "systemd" && runtime.state === "running";
  railStatus.querySelector("strong").textContent = runtime.mode !== "systemd" ? "本地测试模式" : healthy
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
    description: "内网和国内流量直接访问，AI 与境外流量走代理；未知域名先解析真实 IP，仍未分类的流量进入可手动切换的“未分类流量”组。"
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
  proxy: "默认代理出口",
  ai: "AI 出口",
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
  const locked = !canManageRoutingPolicy() || routingPolicySaving;
  renderAiDomainRules();
  if (document.querySelector("#ai-egress-form")?.elements) renderAiEgress();
  document.querySelectorAll('#routing-mode-form input, #routing-mode-form select, #routing-mode-form button, #routing-rule-form input, #routing-rule-form select, #routing-rule-form button').forEach(input => { input.disabled = locked; });
  const mode = routingModeCopy[policy.mode] || routingModeCopy.smart;
  document.querySelectorAll('#routing-mode-form input[name="mode"]').forEach((input) => {
    input.checked = input.value === policy.mode;
    input.disabled = locked || (Boolean(controlPlane.aiUpstream?.config?.enabled) && input.value !== "smart");
  });
  const aiSelection = document.querySelector('#routing-mode-form select[name="aiSelection"]');
  if (aiSelection) aiSelection.value = policy.aiSelection || "fallback";
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
        <button class="icon-button" type="button" data-routing-rule-delete="${escapeHtml(rule.id)}" aria-label="删除规则"${locked ? " disabled" : ""}>${icon("x")}</button>
      </div>
    </div>
  `).join("");
}

function canManageRoutingPolicy() {
  return ["owner", "operator"].includes(controlPlane.currentAdmin?.role);
}

function renderAiDomainRules() {
  const container = document.querySelector("#ai-domain-rules");
  if (!container) return;
  const coverage = controlPlane.aiDomainRules;
  if (!coverage) { container.innerHTML = "<p>当前服务未返回 AI 域名摘要；可通过域名诊断检查具体域名。</p>"; return; }
  const domains = (title, values = []) => `<details><summary>${escapeHtml(title)} · ${values.length}</summary>
    <ul class="ai-domain-list">${values.map(domain => `<li>${escapeHtml(domain)}</li>`).join("") || "<li>暂无条目</li>"}</ul></details>`;
  const rules = coverage.customRules || [];
  container.innerHTML = `<p class="field-hint">内置版本：${escapeHtml(coverage.version || "未提供")} · 自定义域名规则 ${rules.length} 条</p>
    <div class="ai-domain-grid">${domains("内置完整域名", coverage.domainNames)}${domains("内置域名后缀", coverage.domainSuffixes)}
    ${domains("已知共享服务保护", coverage.sharedDomains)}${domains("已知普通大域保护", coverage.protectedDomains)}</div>
    <details${rules.length ? " open" : ""}><summary>自定义覆盖与排除 · ${rules.length}</summary>
      <ul class="ai-domain-overrides">${rules.map(rule => `<li><strong>${escapeHtml(rule.value)}</strong>
        <span>${escapeHtml(routingMatchLabels[rule.match] || rule.match)} · ${escapeHtml(routingActionLabels[rule.action] || rule.action)} · 优先级 ${escapeHtml(rule.priority)} · ${rule.enabled === false ? "已停用" : "已启用"}</span></li>`).join("") || "<li>尚无自定义域名规则；沿用内置识别。</li>"}</ul>
    </details>`;
}

function routingPublicationStatus(sync) {
  if (!sync) return "发布状态未返回；请检查 Runtime 状态";
  if (sync.status === "not-required") return "仅更新订阅；无需 Runtime 发布";
  const simulated = sync.runtimeMode === "dry-run" || sync.status === "simulated";
  if (sync.status === "pending") return `待发布；尚未确认 Runtime 应用${simulated ? "（模拟运行）" : ""}`;
  if (simulated) return "仅模拟；未确认真实 Runtime 应用";
  if (sync.status === "current") return "Runtime 配置已发布；不代表客户端已应用";
  return "发布状态未确认";
}

async function persistRoutingPolicy(nextPolicy, successMessage) {
  if (!canManageRoutingPolicy() || routingPolicySaving) return null;
  const adminId = controlPlane.currentAdmin?.id;
  const generation = controlPlaneConnection.generation;
  const sameSession = () => adminId === controlPlane.currentAdmin?.id && generation === controlPlaneConnection.generation;
  const { runtimeSync: previousSync, ...policy } = nextPolicy;
  routingPolicySaving = true;
  renderRoutingPolicy();
  try {
    const response = await api("/api/settings/routing", { method: "PATCH", body: JSON.stringify(policy) });
    if (!sameSession()) return null;
    const { runtimeSync, ...saved } = response;
    controlPlane.routingPolicy = saved;
    const message = `${successMessage} ${runtimeSync ? routingPublicationStatus(runtimeSync) + "。" : ""}请刷新完整订阅并重新连接。`;
    setText("#routing-save-status", message);
    showToast(runtimeSync?.status === "pending" ? "策略已保存，待发布" : "策略已保存", message);
    await loadBootstrap().catch(() => {});
    return sameSession() ? saved : null;
  } catch (error) {
    if (sameSession()) throw error;
    return null;
  } finally {
    if (sameSession()) { routingPolicySaving = false; renderRoutingPolicy(); }
  }
}

async function saveRoutingMode(event) {
  event.preventDefault();
  if (!canManageRoutingPolicy() || routingPolicySaving) return;
  const form = event.currentTarget;
  const fields = new FormData(form);
  const mode = fields.get("mode");
  const aiSelection = fields.get("aiSelection") || controlPlane.routingPolicy.aiSelection || "fallback";
  try {
    await persistRoutingPolicy(
      { ...controlPlane.routingPolicy, mode, aiSelection },
      "统一路由模式已保存。"
    );
  } catch (error) {
    showToast("保存失败", error.message);
  }
}

async function addRoutingRule(event) {
  event.preventDefault();
  if (!canManageRoutingPolicy() || routingPolicySaving) return;
  const form = event.currentTarget;
  const fields = new FormData(form);
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
  try {
    const saved = await persistRoutingPolicy(
      {
        ...controlPlane.routingPolicy,
        rules: [...controlPlane.routingPolicy.rules, rule]
      },
      "自定义规则已写入所有完整订阅格式。"
    );
    if (saved) { form.reset(); form.elements.priority.value = "100"; }
  } catch (error) {
    showToast("规则未保存", error.message);
  }
}

function renderRoutingDiagnostic(diagnostic) {
  const result = document.querySelector("#routing-diagnose-result");
  if (!result) return;
  const ai = diagnostic.aiDomain;
  const sources = { custom: "自定义规则", builtin: "内置 AI 域名", shared: "已知共享 / 普通域名保护", none: "未匹配 AI 域名", ai: "内置 AI 规则", mode: "全局路由模式" };
  const addresses = diagnostic.addresses || [];
  const aiClassification = ai?.eligible ? "AI 专用域名" : ai?.source === "shared" ? "共享 / 普通保护域名" : "未识别为 AI 专用域名";
  const egressLabels = { residential: "住宅代理出口", server: "默认出口", blocked: "已拦截，无出口", "client-direct": "客户端直连", "client-selection": "未分类流量组，由客户端选择" };
  const terminalAction = ["blocked", "client-direct", "client-selection"].includes(ai?.desiredEgress);
  const sync = ai?.runtimeSync;
  const published = sync?.publishedMode ? `${sync.runtimeMode === "dry-run" || sync.status === "simulated" ? "最近模拟记录" : "最近发布记录"}：${sync.publishedMode === "residential" ? "住宅代理出口" : "默认出口"}` : "";
  result.innerHTML = `
    <div class="full"><small>本次检查域名</small><strong>${escapeHtml(diagnostic.domain || "未提供")}</strong></div>
    <div><small>当前策略推断动作</small><strong>${escapeHtml(routingActionLabels[diagnostic.action] || diagnostic.action || "待确认")}</strong></div>
    <div><small>本次路由命中规则</small><strong>${escapeHtml(sources[diagnostic.source] || diagnostic.source)}${diagnostic.ruleId ? ` · ${escapeHtml(diagnostic.ruleId)}` : ""}</strong></div>
    <div><small>推断代理组</small><strong>${escapeHtml(diagnostic.outbound || "混合结果，需客户端确认")}</strong></div>
    <div><small>策略 DNS</small><strong>${escapeHtml(diagnostic.dns)}</strong></div>
    ${ai ? `<div><small>AI 域名分类</small><strong>${aiClassification}</strong></div>
      <div><small>分类依据</small><strong>${escapeHtml(sources[ai.source] || ai.source)}${ai.match ? ` · ${escapeHtml(routingMatchLabels[ai.match] || ai.match)}` : ""}${ai.value ? ` · ${escapeHtml(ai.value)}` : ""}${ai.ruleId ? ` · ${escapeHtml(ai.ruleId)}` : ""}</strong></div>
      <div><small>${terminalAction ? "当前策略预期结果" : "目标到达主控后的预期出口"}</small><strong>${escapeHtml(egressLabels[ai.desiredEgress] || "尚未确认")}</strong></div>
      <div><small>Runtime 发布状态</small><strong>${escapeHtml(routingPublicationStatus(sync))}</strong></div>
      <p>${escapeHtml(ai.reason || "")}${published ? ` · ${escapeHtml(published)}` : ""}${sync?.message ? ` · ${escapeHtml(sync.message)}` : ""}</p>
      ${ai.note ? `<p>${escapeHtml(ai.note)}</p>` : ""}` : "<p>当前服务未返回 AI 域名分类；以下为现有路由证据。</p>"}
    <div><small>证据来源</small><strong>${diagnostic.evidence?.kind === "control-plane-dns" ? "主控系统 DNS" : "规则推断"}</strong></div>
    <div class="full"><small>解析地址</small><strong>${escapeHtml(addresses.length ? addresses.map(entry => entry.address).join("、") : "无需解析")}</strong></div>
    <p>${escapeHtml(diagnostic.explanation || "")} · ${escapeHtml(new Date(diagnostic.checkedAt).toLocaleString("zh-CN"))}</p>
    <p>这是服务端规则与配置判断，非客户端实测；发布后仍需刷新完整订阅并重新连接。</p>
    ${(diagnostic.warnings || []).map(warning => `<p>${escapeHtml(warning)}</p>`).join("")}`;
}

async function diagnoseRouting(event) {
  event.preventDefault();
  if (routingDiagnosisLoading || !controlPlane.currentAdmin) return;
  const adminId = controlPlane.currentAdmin.id;
  const generation = controlPlaneConnection.generation;
  const sameSession = () => adminId === controlPlane.currentAdmin?.id && generation === controlPlaneConnection.generation;
  const form = event.currentTarget;
  const result = document.querySelector("#routing-diagnose-result");
  const button = form.querySelector('button[type="submit"]');
  routingDiagnosisLoading = true;
  button.disabled = true;
  result.innerHTML = "<span>正在解析域名并匹配规则集…</span>";
  try {
    const diagnostic = await api("/api/routing/diagnose", {
      method: "POST",
      body: JSON.stringify({ domain: form.elements.domain.value.trim() })
    });
    if (sameSession()) renderRoutingDiagnostic(diagnostic);
  } catch (error) {
    if (sameSession()) result.innerHTML = `<span class="danger-text">${escapeHtml(error.message)}</span>`;
  } finally {
    if (sameSession()) { routingDiagnosisLoading = false; button.disabled = false; }
  }
}

function canManageAiEgress() {
  return ["owner", "operator"].includes(controlPlane.currentAdmin?.role);
}

function singleHostAiExit(form) {
  const selection = controlPlane.aiEgress?.aiExit;
  const hosts = controlPlane.hosts;
  if (!selection || !Array.isArray(hosts) || hosts.length !== 1) return null;
  if (selection.mode !== "auto" && !(selection.mode === "pinned" && selection.hostId === hosts[0].id)) return null;
  // Keep edits visible, including a missing Host, when a background refresh changes the Host list.
  if (aiEgressDirty && (form.elements.hostMode.value !== selection.mode
    || (selection.mode === "pinned" && form.elements.hostId.value !== selection.hostId))) return null;
  return { mode: selection.mode, hostId: selection.mode === "pinned" ? selection.hostId : null };
}

function renderAiEgress() {
  const form = document.querySelector("#ai-egress-form");
  if (!form) return;
  const state = controlPlane.aiEgress || {};
  const config = state.upstream || controlPlane.aiUpstream?.config || {};
  const sync = state.runtimeSync || {};
  const selection = state.aiExit || controlPlane.routingPolicy.aiExit || { mode: "auto", hostId: null };
  const hosts = controlPlane.hosts || [];
  if (!aiEgressDirty && !aiEgressSaving) {
    form.elements.mode.value = state.mode || "server";
    form.elements.hostMode.value = selection.mode;
    form.elements.hostId.innerHTML = hosts.map(host =>
      `<option value="${escapeHtml(host.id)}">${escapeHtml(host.name)} (${escapeHtml(host.id)})</option>`).join("");
    if (selection.hostId && !hosts.some(host => host.id === selection.hostId)) {
      form.elements.hostId.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(selection.hostId)}">已移除主机 (${escapeHtml(selection.hostId)})</option>`);
    }
    if (selection.hostId) form.elements.hostId.value = selection.hostId;
    form.elements.type.value = config.type || "socks5";
    form.elements.server.value = config.server || "";
    form.elements.port.value = config.port || 1080;
    form.elements.username.value = config.username || "";
    form.elements.tlsServerName.value = config.tlsServerName || "";
    form.elements.password.value = "";
    form.elements.clearPassword.checked = false;
  }
  form.elements.password.placeholder = config.passwordConfigured ? "已配置；留空保留现有密码" : "代理密码（可选）";
  setText("#ai-egress-password-status", config.passwordConfigured ? "密码已配置，不会回显。" : "尚未配置密码。支持无用户名、无密码的白名单认证。");
  const label = mode => mode === "residential" ? "住宅代理出口" : "默认出口";
  const status = sync.status === "current" ? "配置已发布"
    : sync.status === "pending" ? "已保存，待发布；尚未确认切换生效"
      : sync.status === "simulated" ? "仅模拟，未确认真实出口切换" : "尚未发布";
  const simulated = sync.runtimeMode === "dry-run" || sync.status === "simulated" || sync.runtimeState === "staged";
  const published = simulated ? `${sync.publishedMode ? `最近模拟记录：${label(sync.publishedMode)} · ` : ""}真实发布：未验证（仅模拟）`
    : sync.publishedMode ? `最近成功发布：${label(sync.publishedMode)}` : "最近成功发布：暂无记录";
  setText("#ai-egress-status", `${status} · 已保存选择：${label(state.mode)}。${published}${sync.runtimeState ? ` · Runtime：${sync.runtimeState}` : ""}${sync.message ? `。${sync.message}` : ""}`);
  setText("#ai-egress-edit-status", aiEgressError || (aiEgressDirty ? "有未保存的修改；切换选项不会立即改变出口。" : ""));
  setText("#ai-egress-host-summary", selection.mode === "pinned"
    ? `已保存的默认出口策略：固定 ${hosts.find(host => host.id === selection.hostId)?.name || selection.hostId}。用户必须拥有该主机的使用权限；不可用时停止 AI 连接。`
    : "已保存的默认出口策略：自动选择已授权主机。多个协议在同一主机上不等于多条独立线路。");
  const retry = document.querySelector("#ai-egress-publish");
  retry.hidden = sync.status !== "pending";
  retry.disabled = !canManageAiEgress() || aiEgressSaving || aiEgressDirty;
  syncAiEgressForm();
  const diagnoseButton = document.querySelector('#ai-diagnose-form button[type="submit"]');
  if (diagnoseButton) diagnoseButton.disabled = !canManageAiEgress() || aiDiagnosticsLoading;
  const upstreamEnabled = Boolean(controlPlane.aiUpstream?.config?.enabled);
  setText("#ai-diagnose-source", upstreamEnabled ? "主控经已配置 AI 上游" : "主控服务器直接出站");
  setText("#ai-diagnose-description", upstreamEnabled
    ? "匿名检测主控经已保存上游的 DNS、TLS 和 HTTP；不是已发布 Runtime 或手机路径验收，也不证明登录或模型对话可用。"
    : "匿名检测主控直连的 DNS、TLS 和 HTTP；不是客户端、代理协议或登录后对话验收。");
}

function syncAiEgressForm() {
  const form = document.querySelector("#ai-egress-form");
  if (!form) return;
  const locked = !canManageAiEgress() || aiEgressSaving;
  const residential = form.elements.mode.value === "residential";
  const singleHost = Boolean(singleHostAiExit(form));
  form.querySelectorAll("input, select, button").forEach(input => { input.disabled = locked; });
  for (const [selector, visible] of [["[data-ai-egress-server]", !residential], ["[data-ai-egress-residential]", residential]]) {
    const panel = form.querySelector(selector);
    panel.hidden = !visible;
    panel.disabled = locked || !visible;
  }
  // Disabled hidden controls never participate in browser validation or submission.
  for (const key of ["type", "server", "port", "username", "password", "clearPassword"]) form.elements[key].disabled = locked || !residential;
  form.querySelector("[data-ai-egress-host-options]").hidden = singleHost;
  form.elements.hostMode.disabled = locked || residential || singleHost;
  form.elements.hostId.disabled = locked || residential || singleHost || form.elements.hostMode.value !== "pinned";
  form.elements.hostId.required = !residential && !singleHost && form.elements.hostMode.value === "pinned";
  form.elements.server.required = residential;
  form.elements.port.required = residential;
  const https = residential && form.elements.type.value === "https";
  form.querySelector("[data-ai-egress-tls]").hidden = !https;
  form.elements.tlsServerName.disabled = locked || !https;
  if (!aiEgressSaving) form.querySelector('button[type="submit"]').textContent = "保存并发布";
  setText("#ai-egress-access", canManageAiEgress() ? "保存会校验并发布出口配置，可能重新加载或重启 Runtime。" : "仅 Owner 和运维管理员可修改或发布。");
}

function applyAiEgress(data) {
  controlPlane.aiEgress = data;
  controlPlane.aiUpstream = { config: data.upstream, runtimeSync: data.runtimeSync };
  controlPlane.routingPolicy = { ...controlPlane.routingPolicy, aiExit: data.aiExit,
    ...(data.mode === "residential" ? { mode: "smart" } : {}) };
}

async function saveAiEgress(event) {
  event.preventDefault();
  if (!canManageAiEgress() || aiEgressSaving) return;
  const adminId = controlPlane.currentAdmin?.id;
  const generation = controlPlaneConnection.generation;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const residential = form.elements.mode.value === "residential";
  const password = form.elements.password.value;
  const clearPassword = form.elements.clearPassword.checked;
  if (residential && password && clearPassword) {
    aiEgressError = "请在填写新密码与清除现有密码之间选择一项。";
    setText("#ai-egress-edit-status", aiEgressError); return;
  }
  const body = residential ? { mode: "residential", upstream: {
    type: form.elements.type.value, server: form.elements.server.value.trim(), port: Number(form.elements.port.value) || null,
    username: form.elements.username.value, tlsServerName: form.elements.type.value === "https" ? form.elements.tlsServerName.value.trim() : "",
    ...(password ? { password } : {}), ...(clearPassword ? { clearPassword: true } : {})
  } } : { mode: "server", aiExit: singleHostAiExit(form) || { mode: form.elements.hostMode.value,
    hostId: form.elements.hostMode.value === "pinned" ? form.elements.hostId.value : null } };
  aiEgressError = ""; aiEgressSaving = true;
  button.disabled = true; form.inert = true; button.textContent = "正在保存并发布…";
  try {
    const data = await api("/api/settings/ai-egress", { method: "PATCH", body: JSON.stringify(body) });
    if (adminId !== controlPlane.currentAdmin?.id || generation !== controlPlaneConnection.generation) return;
    form.elements.password.value = "";
    form.elements.clearPassword.checked = false;
    applyAiEgress(data);
    aiEgressDirty = false;
    renderAiDiagnosticReport(null);
    const state = data.runtimeSync?.status;
    showToast(state === "current" ? "AI 出口已保存并发布" : state === "simulated" ? "AI 出口已保存，仅模拟" : "AI 出口已保存，待发布",
      state === "current" ? "请刷新完整订阅并重新连接，以应用出口策略。" : state === "simulated" ? "当前为模拟运行，未确认真实出口切换。" : "选择已保留；尚未确认切换生效，请检查状态并重试发布。");
    await loadBootstrap().catch(() => {});
  } catch (error) {
    if (adminId === controlPlane.currentAdmin?.id && generation === controlPlaneConnection.generation) aiEgressError = `保存失败：${error.message}`;
  } finally {
    if (adminId === controlPlane.currentAdmin?.id && generation === controlPlaneConnection.generation) {
      aiEgressSaving = false; form.inert = false;
      button.disabled = !canManageAiEgress(); button.textContent = "保存并发布";
      renderRoutingPolicy();
    }
  }
}

async function publishAiEgress() {
  if (!canManageAiEgress() || aiEgressSaving || aiEgressDirty) return;
  const adminId = controlPlane.currentAdmin?.id;
  const generation = controlPlaneConnection.generation;
  aiEgressError = ""; aiEgressSaving = true;
  renderAiEgress();
  try {
    const data = await api("/api/settings/ai-egress/publish", { method: "POST", body: "{}" });
    if (adminId !== controlPlane.currentAdmin?.id || generation !== controlPlaneConnection.generation) return;
    applyAiEgress(data);
    await loadBootstrap().catch(() => {});
  } catch (error) {
    if (adminId === controlPlane.currentAdmin?.id && generation === controlPlaneConnection.generation) aiEgressError = `发布失败：${error.message}`;
  } finally {
    if (adminId === controlPlane.currentAdmin?.id && generation === controlPlaneConnection.generation) { aiEgressSaving = false; renderRoutingPolicy(); }
  }
}

function renderAiDiagnosticReport(report) {
  const container = document.querySelector("#ai-diagnose-result");
  if (!container) return;
  if (!report) { container.innerHTML = "<p>尚未检测；重启主控后历史检测结果会清空。</p>"; return; }
  const labels = {
    reachable: "HTTP 有响应", redirect: "收到重定向", challenge: "需要人机验证",
    authentication_required: "需要 API 认证", permission_denied: "访问被拒绝",
    upstream_authentication_required: "住宅代理认证失败",
    rate_limited: "请求受限", upstream_error: "上游服务异常", dns_error: "DNS 解析失败",
    tls_error: "TLS 验证失败", timeout: "连接超时", network_error: "网络错误",
    response_too_large: "响应头超过检测上限"
  };
  const time = (value) => value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("zh-CN") : "时间未知";
  const upstream = report.source === "control-plane-via-upstream";
  const currentRevision = typeof controlPlane !== "undefined" ? controlPlane.aiUpstream?.config?.revision : undefined;
  const oldConfig = upstream && currentRevision != null && report.configRevision !== currentRevision;
  container.innerHTML = `<p>${upstream ? "主控经已配置 AI 上游匿名检测" : "主控服务器直接出站匿名检测"}${upstream && report.configRevision != null ? ` · 配置版本 ${escapeHtml(report.configRevision)}` : ""} · ${escapeHtml(time(report.checkedAt))}。不代表客户端、账户或模型对话可用；未验证已发布 Runtime 路径。</p>
    ${oldConfig ? '<p class="warning-text">此结果来自旧配置，请重新检测当前上游。</p>' : ""}
    <div class="ai-diagnostic-grid">${(report.results || []).map((result) => {
      const latency = typeof result.latencyMs === "number" && Number.isFinite(result.latencyMs)
        ? `${Math.round(result.latencyMs)} ms` : "耗时未知";
      return `<article><strong>${escapeHtml(result.label || result.host)}</strong>
        <span class="status-badge ${result.status === "reachable" ? "neutral" : "warning"}">${escapeHtml(labels[result.status] || "待确认")}</span>
        <small>${escapeHtml(result.host)} · ${escapeHtml(result.stage || "未知阶段")} · ${result.httpStatus ? `HTTP ${escapeHtml(result.httpStatus)}` : "无 HTTP 响应"} · ${latency}</small>
        <p>${escapeHtml(result.message || "")}</p>${result.status === "upstream_authentication_required" ? "<p>请检查上游代理用户名、密码和认证方式；此结果不表示 AI 账户需要 API Key。</p>" : ""}<small>检测于 ${escapeHtml(time(result.checkedAt))}</small></article>`;
    }).join("")}</div>`;
}

async function loadAiDiagnostics() {
  if (aiDiagnosticsLoading) return;
  aiDiagnosticsLoading = true;
  const button = document.querySelector('#ai-diagnose-form button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const data = await api("/api/routing/ai-check");
    const select = document.querySelector("#ai-diagnose-form select");
    const selected = select.value;
    select.innerHTML = '<option value="all">全部预设 AI 服务</option>' + data.services.map((service) =>
      `<option value="${escapeHtml(service.id)}">${escapeHtml(service.label)}</option>`).join("");
    if (["all", ...data.services.map((service) => service.id)].includes(selected)) select.value = selected;
    renderAiDiagnosticReport(data.report);
  } catch (error) {
    setText("#ai-diagnose-result", error.message);
  } finally { aiDiagnosticsLoading = false; if (button) button.disabled = !canManageAiEgress(); }
}

async function diagnoseAiServices(event) {
  event.preventDefault();
  if (aiDiagnosticsLoading || !canManageAiEgress()) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  aiDiagnosticsLoading = true;
  setText("#ai-diagnose-result", controlPlane.aiUpstream?.config?.enabled ? "正在从主控经已配置上游检测预设 AI 服务…" : "正在从主控服务器直接检测预设 AI 服务…");
  try {
    renderAiDiagnosticReport(await api("/api/routing/ai-check", {
      method: "POST", body: JSON.stringify({ service: form.elements.service.value })
    }));
  } catch (error) { setText("#ai-diagnose-result", error.message); }
  finally { button.disabled = !canManageAiEgress(); aiDiagnosticsLoading = false; }
}

function renderDashboard() {
  const runtime = controlPlane.runtime || { state: "not-configured", mode: "dry-run" };
  const hosts = controlPlane.hosts;
  const host = hosts.find((candidate) => candidate.id === "local") || hosts[0];
  const latestAttempt = controlPlane.deployments[0];
  const activeDeployment = controlPlane.deployments.find((deployment) => deployment.status === "active");
  const ready = runtime.mode === "systemd" && runtime.state === "running";
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
    if (runtime.mode !== "systemd") return { label: "本地测试", className: "neutral" };
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
  if (!nodeVersionSupports(host.agentVersion, requiredNodeAgentVersion)) {
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
        <span class="node-name"><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}${host.endpointDomain ? ` · ${escapeHtml(host.endpointDomain)}` : ""}</small></span>
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
          <button class="identity-link" data-open-host="${escapeHtml(host.id)}"><span class="flag">SB</span><span><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}${host.endpointDomain ? ` · ${escapeHtml(host.endpointDomain)}` : ""}</small></span></button>
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
          <small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}${host.endpointDomain ? ` · ${escapeHtml(host.endpointDomain)}` : ""}</small>
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

function hostBbrPresentation(host) {
  const remote = host.kind === "remote";
  const bbr = remote ? host.telemetry?.bbr : controlPlane.bbr;
  if (!remote && controlPlane.runtime?.mode !== "systemd") {
    return { label: "本地测试模式", className: "neutral", detail: "当前环境不配置 Linux BBR，也不提供真实网络加速。", canConfigure: false };
  }
  const fresh = value => {
    const age = Date.now() - new Date(value || "").getTime();
    return Number.isFinite(age) && age >= -5_000 && age <= 60_000;
  };
  const timestamp = bbr?.checkedAt || host.telemetry?.updatedAt;
  const current = fresh(timestamp) && (!remote || (host.status === "online" && fresh(host.lastSeenAt)));
  const canConfigure = (!remote || (host.status === "online" && nodeVersionSupports(host.agentVersion, "0.9.0")))
    && ["owner", "operator"].includes(controlPlane.currentAdmin?.role);
  if (host.bbrTask?.pending) return { label: "BBR 配置中", className: "warning", detail: "配置任务已下发，等待节点执行与新心跳确认。", canConfigure: false };
  if (host.bbrTask?.status === "failed") return { label: "BBR 配置失败", className: "danger", detail: host.bbrTask.error?.message || host.bbrTask.error || "节点配置任务失败，请查看系统权限及内核支持后重试。", canConfigure };
  if (!bbr) return { label: "BBR 待上报", className: "neutral", detail: remote ? "等待节点上报内核拥塞控制状态；旧版 Node 需先升级。" : "尚无内核状态检测结果。", canConfigure };
  const kernel = `拥塞控制 ${bbr.congestionControl || "未知"} · 队列 ${bbr.qdisc || "未知"}`;
  if (!current) return { label: "BBR 状态过期", className: "warning", detail: `${kernel}。此为历史记录，待主机恢复心跳或重新检测后确认。`, canConfigure };
  const labels = {
    enabled: ["BBR 已启用", "good"], available: ["BBR 未启用", "warning"],
    unsupported: ["内核不支持 BBR", "neutral"], unavailable: ["BBR 无法检测", "warning"],
    failed: ["BBR 配置失败", "danger"], development: ["本地测试模式", "neutral"]
  };
  const [label, className] = labels[bbr.status] || ["BBR 待确认", "neutral"];
  return { label, className, detail: `${kernel}${bbr.error ? ` · ${bbr.error}` : ""}。BBR 优化 TCP 拥塞控制，不代表移动网络或 UDP 协议已通过实测。`, canConfigure: canConfigure && !["enabled", "unsupported", "development"].includes(bbr.status) };
}

function hostBbrMarkup(host) {
  const bbr = hostBbrPresentation(host);
  return `<div class="switch-row host-bbr-state"><div><strong>TCP 网络加速</strong><small>${escapeHtml(bbr.detail)}</small></div><span class="status-badge ${bbr.className}">${escapeHtml(bbr.label)}</span></div>
    ${bbr.canConfigure ? `<button type="button" class="button secondary" data-configure-bbr="${escapeHtml(host.id)}">${icon("refresh")}启用 / 重试 BBR 配置</button>` : ""}`;
}

function renderHosts() {
  if (!elements.hostBody) return;
  const hosts = controlPlane.hosts;
  const runtime = controlPlane.runtime || { state: "unknown", mode: "dry-run" };
  renderHostTopology(hosts, runtime);
  if (!hosts.length) {
    elements.hostBody.innerHTML = '<tr><td colspan="8"><div class="empty-state">尚未配置 Runtime 主机</div></td></tr>';
    return;
  }
  elements.hostBody.innerHTML = hosts.map((host) => {
    const bbr = hostBbrPresentation(host);
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
      ? runtime.mode === "systemd" && runtime.state === "running"
      : host.status === "online"
        && nodeVersionSupports(host.agentVersion, requiredNodeAgentVersion)
        && host.telemetry?.serviceStatus === "running";
    const status = isLocal
      ? (runtime.mode !== "systemd" ? "本地测试" : healthy ? "运行中" : runtime.state === "staged" ? "已暂存" : "待配置")
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
      : host.agentVersion && !nodeVersionSupports(host.agentVersion, requiredNodeAgentVersion)
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
      <td><button class="identity-link" data-open-host="${escapeHtml(host.id)}"><span class="flag">SB</span><span><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}${host.endpointDomain ? ` · ${escapeHtml(host.endpointDomain)}` : ""}</small></span></button></td>
      <td><span class="status-badge ${statusClass}"><i></i>${status}</span></td>
      <td>${protocolLabels.length
        ? `<div class="host-protocol-tags" aria-label="已启用 ${protocolLabels.length} 个入口协议">${protocolLabels.map(({ name, connection }) => `<span class="tag protocol-latency-tag"><span>${escapeHtml(name)}</span><em class="protocol-latency-value ${connection.className}" title="${escapeHtml(connection.title)}">${escapeHtml(connection.summary)}</em></span>`).join("")}</div>`
        : '<span class="tag">尚未启用</span>'}</td>
      <td>${isLocal ? "控制面本机" : "RayLink Node"}</td>
      <td>${escapeHtml(isLocal ? runtime.platform || "local" : [host.platform, host.architecture].filter(Boolean).join(" / ") || "等待上报")}</td>
      <td><span class="status-badge ${bbr.className}" title="${escapeHtml(bbr.detail)}">${escapeHtml(bbr.label)}</span></td>
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

function runtimeSetupPresentation() {
  const setup = controlPlane.runtimeSetup || {};
  const development = controlPlane.runtime?.mode !== "systemd" || setup.status === "development" || (controlPlane.runtime?.platform && controlPlane.runtime.platform !== "linux");
  const running = runtimeSetupRequest.running || setup.status === "running";
  const failed = runtimeSetupRequest.error || setup.status === "failed";
  if (running) return { title: "正在安装与配置 Runtime", className: "warning", message: setup.message || "正在安装组件、准备服务、配置已启用入口协议与防火墙并检查运行状态。", button: "正在配置…", busy: true };
  if (development) return { title: "本地测试模式", className: "neutral", message: "此环境不运行 Linux 代理服务，也不启用 BBR 加速。已下载二进制不代表服务可用；自动安装与配置请在 Linux 正式部署上执行。", button: "仅支持 Linux 正式部署", busy: false, blocked: true };
  if (failed) return { title: "安装配置未完成", className: "danger", message: runtimeSetupRequest.error || setup.error?.message || setup.error || setup.message || "请查看失败步骤，修复后重试。", button: "重试完整配置", busy: false };
  if (setup.status === "succeeded" && controlPlane.runtime?.state === "running") return { title: "安装与配置完成", className: "good", message: setup.message || "Runtime 服务与已启用入口协议已配置，运行检查通过。BBR 结果请以独立内核状态为准。", button: "重新检查与配置", busy: false };
  return { title: setup.status === "succeeded" ? "配置已完成，等待运行确认" : "一键安装与配置", className: "neutral", message: setup.message || "自动安装组件、保留并配置已启用入口协议与防火墙、发布并检查监听；默认入口为 Shadowsocks，内核支持时配置 BBR。", button: "一键安装与配置", busy: false };
}

function runtimeSetupMarkup() {
  const presentation = runtimeSetupPresentation();
  const setup = controlPlane.runtimeSetup || {};
  const canManage = ["owner", "operator"].includes(controlPlane.currentAdmin?.role);
  const statusLabels = { pending: "等待", running: "进行中", succeeded: "完成", completed: "完成", failed: "失败", warning: "需注意", skipped: "跳过", development: "本地测试" };
  const steps = Array.isArray(setup.steps) ? setup.steps : [];
  return `<div class="runtime-setup-heading"><div><strong>${escapeHtml(presentation.title)}</strong><p>${escapeHtml(presentation.message)}</p></div><span class="status-badge ${presentation.className}">${presentation.busy ? "执行中" : presentation.className === "good" ? "已验证" : presentation.className === "danger" ? "可重试" : "待检查"}</span></div>
    ${steps.length ? `<ol class="runtime-setup-steps">${steps.map(step => `<li class="${step.status === "failed" ? "failed" : ["succeeded", "completed"].includes(step.status) ? "complete" : "pending"}"><span><strong>${escapeHtml(step.label || step.id || "配置步骤")}</strong><small>${escapeHtml(step.message || "")}</small></span><em>${escapeHtml(statusLabels[step.status] || step.status || "等待")}</em></li>`).join("")}</ol>` : ""}
    ${canManage ? `<button type="button" class="button primary" data-install-runtime ${presentation.busy || presentation.blocked ? "disabled" : ""}>${icon(presentation.busy ? "refresh" : "terminal")}${escapeHtml(presentation.button)}</button>` : '<p class="field-hint">仅 Owner 或运维管理员可安装与配置。</p>'}`;
}

function renderRuntimeSetup() {
  document.querySelectorAll("[data-runtime-setup]").forEach(target => { target.innerHTML = runtimeSetupMarkup(); });
}

function renderSystemRuntime() {
  const runtime = controlPlane.runtime || { state: "unknown", mode: "dry-run" };
  const installation = controlPlane.installation || { installed: false, version: null };
  const activeDeployment = controlPlane.deployments.find((deployment) => deployment.status === "active");
  const latestDeployment = controlPlane.deployments[0];
  setText("#system-runtime-state", runtime.mode !== "systemd" ? "本地测试 · 未提供代理服务" : runtime.state === "running" ? "运行中"
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

function systemUpdatePresentation() {
  const update = controlPlane.systemUpdate || {};
  const task = update.task || {};
  const development = controlPlane.runtime?.mode !== "systemd";
  const pending = systemUpdateRequest.upgrading || ["queued", "running"].includes(task.status);
  const blockedReason = development ? "本地测试模式不执行主控系统更新，请在 Linux 正式部署上更新。" : update.blockedReason;
  const failed = task.status === "failed" || update.status === "error";
  return {
    pending,
    canUpgrade: !blockedReason && update.supported !== false && !pending && update.updateAvailable === true && controlPlane.currentAdmin?.role === "owner",
    title: pending ? "主控更新进行中" : failed ? "主控更新未完成" : task.status === "succeeded" ? "最近主控更新已完成" : "RayLink 控制面",
    className: pending ? "warning" : failed ? "danger" : "neutral",
    message: systemUpdateRequest.error || blockedReason || task.error || task.message || update.error
      || (update.updateAvailable ? `可更新到 ${update.latestVersion}。` : update.status === "ready" ? "当前没有可用的主控更新。" : "检查 RayLink 主控程序更新；sing-box 与节点服务独立管理。")
  };
}

function renderSystemUpdate() {
  const update = controlPlane.systemUpdate || {};
  const state = systemUpdatePresentation();
  setText("#control-plane-update-title", state.title);
  setText("#control-plane-version", `当前 ${update.currentVersion || "待读取"}${update.latestVersion ? ` · 可用版本 ${update.latestVersion}` : ""}`);
  setText("#control-plane-update-state", state.message);
  const badge = document.querySelector("#control-plane-update-badge");
  if (badge) { badge.className = `status-badge ${state.className}`; badge.textContent = state.pending ? "执行中" : state.className === "danger" ? "需检查" : "主控程序"; }
  const check = document.querySelector("[data-check-system-update]");
  if (check) { check.disabled = systemUpdateRequest.checking || state.pending; check.textContent = systemUpdateRequest.checking ? "正在检查…" : "检查主控更新"; }
  const upgrade = document.querySelector("[data-upgrade-system]");
  if (upgrade) { upgrade.hidden = !state.canUpgrade && !state.pending; upgrade.disabled = !state.canUpgrade; upgrade.textContent = state.pending ? "正在更新…" : update.task?.status === "failed" ? "重试主控更新" : "更新 RayLink 主控"; }
  document.querySelectorAll("[data-node-update-state]").forEach(target => {
    const host = controlPlane.hosts.find(item => item.id === target.dataset.nodeUpdateState);
    if (host) target.innerHTML = nodeUpdateMarkup(host);
  });
  document.querySelectorAll("[data-host-bbr-state]").forEach(target => {
    const host = controlPlane.hosts.find(item => item.id === target.dataset.hostBbrState);
    if (host) target.innerHTML = hostBbrMarkup(host);
  });
}

function nodeUpdateMarkup(host) {
  const upgrade = host.nodeUpgrade || {};
  const pending = upgrade.pending || ["queued", "running"].includes(upgrade.status);
  const targetVersion = upgrade.availableVersion || upgrade.targetVersion || requiredNodeAgentVersion;
  const needed = !nodeVersionSupports(host.agentVersion, targetVersion);
  const canManage = controlPlane.currentAdmin?.role === "owner";
  const blocked = upgrade.blockedReason || (host.status !== "online" ? "节点离线，恢复心跳后再更新。" : "");
  const canUpgrade = needed && !pending && nodeVersionSupports(host.agentVersion, "0.9.0") && upgrade.supported !== false && !blocked && canManage;
  const label = pending ? "Node 更新中" : upgrade.status === "failed" ? "Node 更新失败" : needed ? "Node 可更新" : "Node 已匹配";
  const message = upgrade.error || upgrade.message || blocked || (needed ? `当前 ${host.agentVersion || "未知版本"}，目标 ${targetVersion}。更新节点管理服务后可采集和配置 BBR；0.8 节点仍可升级 sing-box。` : `当前 ${host.agentVersion}。Node 服务负责心跳、配置应用与 BBR 状态采集。`);
  return `<div class="switch-row"><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(message)}</small></div><span class="status-badge ${upgrade.status === "failed" ? "danger" : pending || needed ? "warning" : "neutral"}">${escapeHtml(host.agentVersion || "未上报")}</span></div>
    ${canUpgrade ? `<button type="button" class="button primary" data-upgrade-node="${escapeHtml(host.id)}">${icon("arrow")}${upgrade.status === "failed" ? "重试 Node 更新" : "更新 Node 服务"}</button>` : ""}`;
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
    upgradeButton.hidden = update?.updateAvailable !== true || installation.platform !== "linux" || controlPlane.runtime?.mode !== "systemd";
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
  renderCertificateRenewal();
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

function renderCertificateRenewal() {
  const renewal = controlPlane.tlsRenewal;
  const labels = { idle: "等待检查", healthy: "同步正常", warning: "需要关注", error: "同步失败", disabled: "当前运行模式不支持自动同步" };
  setText("#certificate-renewal-status", labels[renewal?.status] || "等待检查");
  setText("#certificate-renewal-checked", renewal?.checkedAt ? `最近检查：${new Date(renewal.checkedAt).toLocaleString("zh-CN")}` : "每 15 分钟检查 Caddy 续期结果；证书变化时自动应用并验证。检查周期可由管理员配置。");
  const list = document.querySelector("#certificate-renewal-list");
  if (list) list.innerHTML = (renewal?.certificates || []).map((cert) => `<p><strong>${escapeHtml(cert.domain)}</strong><br>到期：${escapeHtml(cert.validTo && Number.isFinite(Date.parse(cert.validTo)) ? new Date(cert.validTo).toLocaleString("zh-CN") : "未知（无法读取）")} · ${escapeHtml(cert.status === "expired" ? "已过期" : cert.status === "expiring" ? "即将到期" : cert.status === "healthy" ? "有效" : cert.status)}${cert.errorCode ? ` · ${escapeHtml(cert.errorCode)}` : ""}</p>`).join("") || "<p>没有已发布的本机托管证书。</p>";
  setText("#certificate-renewal-error", renewal?.errorCode ? `错误：${renewal.errorCode}。请检查证书来源和运行状态后重试。` : "");
  const button = document.querySelector("#sync-runtime-certificates");
  if (button) {
    button.disabled = certificateSyncRunning || renewal?.status === "disabled" || !["owner", "operator"].includes(controlPlane.currentAdmin?.role);
    button.textContent = certificateSyncRunning ? "正在同步并验证…" : "检查并同步证书";
  }
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
  const sensitive = (scope) => ["secrets.read", "admins.manage", "hosts.provision"].includes(scope.id);
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
  if (target && !target.contains(document.activeElement)) {
    target.innerHTML = controlPlane.admins.length
      ? controlPlane.admins.map((admin) => `
        <div class="admin-access-row" data-admin-row="${escapeHtml(admin.id)}">
          <label class="field"><span class="sr-only">管理员用户名</span><input data-admin-username ${admin.id === controlPlane.currentAdmin?.id ? "disabled" : ""} value="${escapeHtml(admin.username)}" minlength="3" maxlength="64" aria-label="${escapeHtml(admin.username)} 的用户名" autocomplete="off"><small>创建于 ${new Date(admin.createdAt).toLocaleString("zh-CN")}</small></label>
          <select data-admin-role aria-label="${escapeHtml(admin.username)} 的角色">
            ${["owner", "operator", "support", "auditor"].map((role) => (
              `<option value="${role}" ${admin.role === role ? "selected" : ""}>${role}</option>`
            )).join("")}
          </select>
          <input data-admin-password ${admin.id === controlPlane.currentAdmin?.id ? 'disabled placeholder="请从个人登录信息修改"' : 'placeholder="留空则不重置密码"'} type="password" minlength="12" autocomplete="new-password" aria-label="重置 ${escapeHtml(admin.username)} 的密码">
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
  const username = row.querySelector("[data-admin-username]").value.trim();
  button.disabled = true;
  try {
    await api(`/api/admins/${encodeURIComponent(adminId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        role: row.querySelector("[data-admin-role]").value,
        ...(adminId !== controlPlane.currentAdmin?.id ? { username, ...(password ? { password } : {}) } : {})
      })
    });
    row.querySelector("[data-admin-password]").value = "";
    await loadBootstrap();
    showToast("管理员已更新", password ? "登录信息已更新，该账号的会话和 MCP Token 已撤销。" : "用户名和角色已保存。");
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

function renderNodeDomainSettings() {
  const form = document.querySelector("#node-domain-settings-form");
  const settings = controlPlane.nodeDomains || {};
  const owner = controlPlane.currentAdmin?.role === "owner";
  form.elements.provider.value = settings.provider || "disabled";
  form.elements.zoneId.value = settings.zoneId || "";
  form.elements.baseDomain.value = settings.baseDomain || "";
  form.elements.apiToken.value = "";
  form.elements.apiToken.placeholder = settings.tokenConfigured ? "已配置；留空保留现有 Token" : "Cloudflare API Token";
  form.elements.autoProvision.checked = Boolean(settings.autoProvision);
  form.elements.inheritProtocols.checked = settings.inheritProtocols !== false;
  form.querySelectorAll("input, select, button").forEach(input => { input.disabled = !owner; });
  setText("#node-domain-status", `${settings.tokenConfigured ? "DNS Token 已配置" : "尚未配置 DNS Token"}${owner ? " · Token 不会回显" : " · 仅 Owner 可修改"}`);
  syncNodeDomainProvider();
}

function syncNodeDomainProvider() {
  const form = document.querySelector("#node-domain-settings-form");
  const enabled = form.elements.provider.value === "cloudflare";
  form.querySelector("[data-cloudflare-fields]").hidden = !enabled;
  form.elements.zoneId.required = enabled;
  form.elements.baseDomain.required = enabled;
}

async function loadNodeDomainSettings() {
  const adminId = controlPlane.currentAdmin?.id;
  if (!adminId) return;
  try {
    const data = await api("/api/settings/node-domains", { signal: AbortSignal.timeout(15_000) });
    if (adminId !== controlPlane.currentAdmin?.id) return;
    controlPlane.nodeDomains = data.nodeDomains;
    renderNodeDomainSettings();
  } catch (error) {
    if (adminId === controlPlane.currentAdmin?.id) setText("#node-domain-status", `读取失败：${error.message}`);
  }
}

async function saveNodeDomainSettings(event) {
  event.preventDefault();
  if (controlPlane.currentAdmin?.role !== "owner") return;
  const adminId = controlPlane.currentAdmin.id;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  const apiToken = form.elements.apiToken.value.trim();
  try {
    const data = await api("/api/settings/node-domains", { method: "PATCH", body: JSON.stringify({
      provider: form.elements.provider.value, zoneId: form.elements.zoneId.value.trim(), baseDomain: form.elements.baseDomain.value.trim(),
      autoProvision: form.elements.autoProvision.checked, inheritProtocols: form.elements.inheritProtocols.checked,
      ...(apiToken ? { apiToken } : {})
    }) });
    form.elements.apiToken.value = "";
    if (adminId !== controlPlane.currentAdmin?.id) return;
    controlPlane.nodeDomains = data.nodeDomains;
    renderNodeDomainSettings();
    showToast("节点域名设置已保存", "新的自动接入任务将使用此设置，现有主机不受影响。");
  } catch (error) {
    if (adminId === controlPlane.currentAdmin?.id) setText("#node-domain-status", `保存失败：${error.message}`);
  } finally {
    button.disabled = controlPlane.currentAdmin?.role !== "owner";
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

function usagePeriodPresentation(period) {
  const resetsAt = typeof period?.resetsAt === "string" ? new Date(period.resetsAt) : null;
  const monthly = period?.timeZone === "Asia/Shanghai"
    && /^\d{4}-(0[1-9]|1[0-2])$/.test(period.key || "")
    && /(?:Z|[+-]\d{2}:\d{2})$/i.test(period.resetsAt || "")
    && resetsAt && Number.isFinite(resetsAt.getTime());
  return {
    monthly: Boolean(monthly),
    usedLabel: monthly ? "本月已用" : "已用流量",
    quotaLabel: monthly ? "每月额度" : "流量额度",
    reset: monthly
      ? `下次重置（北京时间）：${new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).format(resetsAt)}`
      : "未收到月度周期信息，自动重置状态待确认。"
  };
}

function renderUsers() {
  const period = usagePeriodPresentation(controlPlane.usagePeriod);
  setText("#user-usage-heading", `${period.usedLabel} / ${period.quotaLabel}`);
  setText("#user-usage-period", period.monthly
    ? `按自然月计量，每月 1 日 00:00（北京时间）自动重置。${period.reset}`
    : period.reset);
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
    const usage = usagePeriodPresentation(user.usagePeriod);
    return `
      <tr>
        <td>
          <button class="identity-link" data-user="${escapeHtml(user.email)}">
            <span class="avatar">${escapeHtml(user.initials)}</span>
            <span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}</small></span>
          </button>
        </td>
        <td><span class="status-badge ${status.className}"><i></i>${status.label}</span></td>
        <td class="usage-cell" data-usage-label="${usage.usedLabel} / ${usage.quotaLabel}">
          <div class="usage-copy"><span>${user.used.toFixed(1)} GB</span><span>${user.quota} GB</span></div>
          <div class="progress ${progressClass}"><i style="width:${ratio.toFixed(1)}%"></i></div>
          <small class="usage-reset">${escapeHtml(usage.reset)}</small>
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
  stopControlPlaneRefresh();
  runtimeSetupRequest.running = false;
  runtimeSetupRequest.error = "";
  systemUpdateRequest.checking = false;
  systemUpdateRequest.upgrading = false;
  systemUpdateRequest.error = "";
  clearProvisioning();
  clearMcpAccess();
  setProfileMenu(false);
  closeDrawer({ restoreFocus: false, clearContent: true });
  document.documentElement.classList.remove("hide-root-scrollbar");
  controlPlane.currentAdmin = null;
  controlPlane.usagePeriod = null;
  controlPlane.nodeDomains = null;
  controlPlane.aiUpstream = null;
  controlPlane.aiEgress = null;
  controlPlane.aiDomainRules = null;
  routingPolicySaving = false;
  routingDiagnosisLoading = false;
  const routingDiagnoseButton = document.querySelector('#routing-diagnose-form button[type="submit"]');
  if (routingDiagnoseButton) routingDiagnoseButton.disabled = false;
  setText("#routing-diagnose-result", "输入域名后，将展示分类、规则与发布状态。");
  setText("#routing-save-status", "");
  aiEgressDirty = false;
  aiEgressSaving = false;
  aiEgressError = "";
  const upstreamForm = document.querySelector("#ai-egress-form");
  upstreamForm?.reset();
  if (upstreamForm) upstreamForm.inert = false;
  document.querySelector("#node-domain-settings-form")?.reset();
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

function clearPersonalAccountSecrets() {
  elements.drawerContent.querySelectorAll('[data-personal-account] input[type="password"]').forEach((input) => { input.value = ""; });
}

function openPersonalAccount(mode = "profile") {
  if (!controlPlane.currentAdmin) return;
  setProfileMenu(false);
  const password = mode === "password";
  openDrawer({
    title: "个人登录信息", eyebrow: "我的账号", saveLabel: "保存并重新登录",
    content: `<div class="account-mode-switch" role="group" aria-label="修改登录信息">
      <button type="button" class="button ${password ? "secondary" : "primary"}" data-account-mode="profile" aria-pressed="${!password}">修改用户名</button>
      <button type="button" class="button ${password ? "primary" : "secondary"}" data-account-mode="password" aria-pressed="${password}">修改密码</button>
    </div>
    <form id="account-${password ? "password" : "profile"}-form" data-personal-account class="drawer-form">
      <p class="field-hint">当前账号：${escapeHtml(controlPlane.currentAdmin.username)}。修改成功后，所有浏览器会话将退出，需要重新登录。${password ? "此账号的全部 MCP Token 也会立即撤销，请重新创建并更新客户端配置。" : "现有 MCP Token 保持有效。"}</p>
      ${password ? `<input type="text" name="username" autocomplete="username" value="${escapeHtml(controlPlane.currentAdmin.username)}" hidden>` : `<label class="field"><span>新用户名</span><input name="username" value="${escapeHtml(controlPlane.currentAdmin.username)}" minlength="3" maxlength="64" pattern="[a-zA-Z0-9][a-zA-Z0-9_.\\-]{2,63}" autocomplete="username" required><small>3–64 位字母、数字、下划线、点或短横线，以字母或数字开头。</small></label>`}
      <label class="field"><span>当前密码</span><input name="currentPassword" type="password" autocomplete="current-password" maxlength="1024" required></label>
      ${password ? `<label class="field"><span>新密码</span><input name="newPassword" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required><small>至少 12 位，须与当前密码不同。</small></label><label class="field"><span>确认新密码</span><input name="confirmPassword" type="password" minlength="12" maxlength="1024" autocomplete="new-password" required></label>` : ""}
      <button type="submit" hidden>保存并重新登录</button>
    </form>`
  });
}

async function savePersonalAccountForm(form) {
  if (form.dataset.saving === "true") return;
  const adminId = controlPlane.currentAdmin?.id;
  if (!adminId) return;
  form.querySelector?.("[data-form-error]")?.remove();
  const password = form.id === "account-password-form";
  if (password && form.elements.newPassword.value !== form.elements.confirmPassword.value) {
    showDrawerFormError(form, new Error("两次输入的新密码不一致。"));
    return;
  }
  const username = password ? controlPlane.currentAdmin.username : form.elements.username.value.trim();
  const body = { currentPassword: form.elements.currentPassword.value };
  if (password) body.newPassword = form.elements.newPassword.value;
  else body.username = username;
  form.dataset.saving = "true";
  elements.drawerSave.disabled = true;
  elements.drawerSave.textContent = "正在保存…";
  try {
    await api(`/api/account/${password ? "password" : "profile"}`, { method: password ? "POST" : "PATCH", body: JSON.stringify(body) });
    if (adminId !== controlPlane.currentAdmin?.id) return;
    clearPersonalAccountSecrets();
    showAdminLogin();
    elements.authForm.elements.username.value = username;
    elements.authError.textContent = password ? "密码已更新，所有会话和 MCP Token 已撤销。请使用新密码重新登录。" : "用户名已更新，所有会话已退出。请使用新用户名重新登录。";
  } catch (error) {
    if (adminId !== controlPlane.currentAdmin?.id) return;
    if (error.status === 401 || error.code === "ACCOUNT_CHANGED") { showAdminLogin(); elements.authError.textContent = "账号信息已变化，请重新登录。"; return; }
    if (form.isConnected) showDrawerFormError(form, error);
  } finally {
    delete form.dataset.saving;
    if (form.isConnected) { elements.drawerSave.disabled = false; elements.drawerSave.textContent = "保存并重新登录"; }
  }
}

function openDrawer({ title, eyebrow, content, saveLabel = "保存更改" }) {
  clearPersonalAccountSecrets();
  clearProvisioningSecrets(elements.drawerContent.querySelector("#provision-host-form"));
  provisioning.drawerJobId = null;
  lastFocusedElement = document.activeElement;
  elements.drawerTitle.textContent = title;
  elements.drawerEyebrow.textContent = eyebrow;
  elements.drawerContent.innerHTML = content;
  elements.drawerSave.textContent = saveLabel;
  elements.drawerSave.disabled = false;
  elements.drawer.classList.add("open");
  elements.drawerScrim.classList.add("open");
  elements.drawer.setAttribute("aria-hidden", "false");
  elements.drawer.removeAttribute("inert");
  document.body.style.overflow = "hidden";
  setTimeout(() => elements.drawerClose.focus(), 50);
}

function closeDrawer({ restoreFocus = true, clearContent = false } = {}) {
  clearPersonalAccountSecrets();
  clearProvisioningSecrets(elements.drawerContent.querySelector("#provision-host-form"));
  provisioning.drawerJobId = null;
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
              <a class="subscription-client-action" href="#" data-subscription-format="mihomo-modern" data-subscription-import="clash">
                <span><strong>Mihomo 共享测速</strong><small>需要内核 1.19.1+；减少重复探测</small></span>
                <span class="subscription-client-badge">导入</span>
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
  const usage = usagePeriodPresentation(user.usagePeriod || controlPlane.usagePeriod);
  const initialUsedGb = Number(user.used || 0).toFixed(1);
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
    <form class="drawer-form" id="user-drawer-form" data-user-id="${escapeHtml(user.id || "")}" data-initial-used-gb="${initialUsedGb}" data-usage-period-key="${escapeHtml(user.usagePeriod?.key || controlPlane.usagePeriod?.key || "")}">
      <div class="drawer-profile">
        <span class="avatar">${escapeHtml(user.initials || "新")}</span>
        <div><strong>${escapeHtml(user.name || "新用户")}</strong><small>${isNew ? "一次完成账号与权益设置" : escapeHtml(user.email)}</small></div>
      </div>
      <p class="drawer-section-label">基本信息</p>
      <label class="field"><span>显示名称</span><input name="name" value="${escapeHtml(user.name || "")}" placeholder="例如：徐清扬" required><small class="field-error"></small></label>
      <label class="field"><span>邮箱</span><input name="email" type="email" value="${escapeHtml(user.email || "")}" placeholder="name@company.com" required><small class="field-error"></small></label>
      ${isNew ? '<label class="field"><span>初始密码</span><input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="至少 8 位" required><small class="field-error"></small></label>' : ""}
      <label class="field"><span>到期时间</span><input name="expires" type="date" value="${escapeHtml(user.expires || "2026-12-31")}" required><small class="field-error"></small></label>
      <label class="field"><span>${usage.usedLabel}（GB）</span><input name="usedGb" type="number" min="0" step="0.1" value="${initialUsedGb}" required><small class="field-error"></small><small class="field-hint">${usage.monthly ? "本月用量自动计量；仅在需要账务校正时修改。" : "用量由 Runtime 自动计量；仅在需要账务校正时修改。"}</small></label>
      <p class="drawer-section-label">用户权益</p>
      <label class="field"><span>${usage.quotaLabel}（GB）</span><input name="quota" type="number" min="1" step="1" value="${Number(user.quota || 120)}" required><small class="field-error"></small></label>
      <p class="usage-period-note">${usage.monthly ? "每月 1 日 00:00（北京时间）自动重置已用流量，额度不变。" : ""}${escapeHtml(usage.reset)}</p>
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
  const verifiedActivation = ["port-listening", "public-ready"].includes(activation?.state);
  if (profile.enabled && host.kind !== "remote" && (!activation || verifiedActivation)
    && controlPlane.runtime?.mode !== "systemd") {
    return { label: "本地测试配置", className: "neutral", activation: null };
  }
  if (verifiedActivation && host.kind !== "remote" && controlPlane.runtime?.state !== "running") {
    return { label: "服务未运行", className: "warning", activation: null };
  }
  if (activation && protocolStatePresentation[activation.state]) {
    const [label, className] = protocolStatePresentation[activation.state];
    return { label, className, activation };
  }
  const pending = applied
    ? JSON.stringify(profile) !== JSON.stringify(applied)
    : profile.enabled;
  return {
    label: pending ? "待发布" : profile.enabled ? "已配置，待验证" : "未启用",
    className: pending || profile.enabled ? "warning" : "neutral",
    activation: null
  };
}

function hostDrawerMarkup(hostId) {
  const host = controlPlane.hosts.find((item) => item.id === hostId);
  const isRemote = host.kind === "remote";
  const nodeNeedsUpgrade = isRemote
    && host.enrolledAt
    && !nodeVersionSupports(host.agentVersion, requiredNodeAgentVersion);
  const runtimeUpdate = controlPlane.runtimeUpdate;
  const runtimeCanUpgrade = isRemote
    && nodeVersionSupports(host.agentVersion, "0.8.0")
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
    : controlPlane.runtime?.mode === "systemd" && controlPlane.runtime?.state === "running";
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
      <div class="drawer-profile"><span class="avatar">${escapeHtml(host.name.slice(0, 1))}</span><div><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}${host.endpointDomain ? ` · ${escapeHtml(host.endpointDomain)}` : ""}</small></div></div>
      <p class="drawer-section-label">主机连接</p>
      <label class="field"><span>名称</span><input name="hostname" value="${escapeHtml(host.name)}" placeholder="例如：东京生产节点" required></label>
      <label class="field"><span>节点连接地址（每台 Host 独立）</span><input name="address" value="${escapeHtml(host.address)}" placeholder="node.example.com" required><small class="field-hint">每台 Host 可以使用不同的域名或公网 IP，订阅会使用这里的地址连接该节点。</small></label>
      <label class="field"><span>区域标识</span><input name="region" value="${escapeHtml(host.region)}" pattern="[A-Za-z0-9-]{2,32}" placeholder="tokyo" required></label>
      <p class="drawer-section-label">主机诊断</p>
      <div class="diagnostic-grid host-diagnostic-grid">${diagnosticMarkup}</div>
      <div data-host-bbr-state="${escapeHtml(host.id)}">${hostBbrMarkup(host)}</div>
      <button type="button" class="button secondary" data-refresh-host-diagnostics="${escapeHtml(host.id)}">${icon("refresh")}刷新主机诊断</button>
      <p class="drawer-section-label">入口协议</p>
      <p class="field-hint">协议属于当前主机。一键启用会完成配置、校验、发布、端口检查，并在成功后自动进入用户订阅。</p>
      <div class="host-protocol-list">${groupMarkup}</div>
      <button type="button" class="button secondary" data-measure-host-latency="${escapeHtml(host.id)}">${icon("refresh")}测试全部协议连接</button>
      <p class="field-hint">每个公网协议执行 5 次完整握手与外部访问，显示中位连接耗时和抖动；连续 3 轮失败后才标记超时。本机及高级系统协议标记为不适用。</p>
      <div class="switch-row"><div><strong>${isRemote ? "RayLink Node" : "Runtime 模式"}</strong><small>${escapeHtml(runtimeCopy)}</small></div><span class="status-badge neutral"><i></i>${escapeHtml(isRemote ? host.status : controlPlane.runtime?.state || "unknown")}</span></div>
      ${!isRemote
        ? `<section class="runtime-setup-card" data-runtime-setup aria-live="polite">${runtimeSetupMarkup()}</section>`
        : ""}
      <div class="switch-row"><div><strong>用户流量计量</strong><small>${usageMeteringDescription(host.usageMetering)}</small></div><span class="status-badge ${host.usageMetering?.status === "healthy" ? "good" : host.usageMetering?.status === "error" ? "danger" : "warning"}"><i></i>${usageMeteringLabel(host.usageMetering)}</span></div>
      ${isRemote ? `<div class="switch-row"><div><strong>TLS 资产安全通道</strong><small>${host.assetEncryptionReady ? "节点 X25519 公钥已登记；证书私钥将以节点专属密封包下发。" : "请升级并重启 RayLink Node，使其生成并上报资产加密公钥。"}</small></div><span class="status-badge ${host.assetEncryptionReady ? "good" : "warning"}"><i></i>${host.assetEncryptionReady ? "已就绪" : "待升级"}</span></div>` : ""}
      ${isRemote ? `<div class="switch-row"><div><strong>配置应用</strong><small>${escapeHtml(deploymentApplicationCopy)}</small></div><span class="status-badge ${host.deploymentSync?.critical ? "danger" : host.deploymentSync?.pendingTaskCount ? "warning" : "good"}"><i></i>${escapeHtml(host.deploymentSync?.status === "revocation-pending" ? "撤权待应用" : host.deploymentSync?.status === "pending" ? "待应用" : "已应用")}</span></div>` : ""}
      ${isRemote && !host.enrolledAt
        ? `<button type="button" class="button secondary" data-reissue-host="${escapeHtml(host.id)}">${icon("refresh")}重新生成接入命令</button><p class="field-hint">新的接入令牌会立即替换之前的令牌。</p>`
        : ""}
      ${isRemote && host.enrolledAt ? `<p class="drawer-section-label">Node 管理服务</p><div data-node-update-state="${escapeHtml(host.id)}">${nodeUpdateMarkup(host)}</div>` : ""}
      ${nodeNeedsUpgrade
        ? `<details class="node-manual-upgrade"><summary>无法在线更新时，使用服务器命令</summary><p class="field-hint">更新只替换 Node 程序与构建器，保留身份及当前 Runtime。完成后等待心跳确认版本。</p><pre class="advanced-preview"><code id="node-upgrade-command">${escapeHtml(nodeUpgradeCommand)}</code></pre><button type="button" class="button secondary" data-copy-target="node-upgrade-command">${icon("copy")}复制升级命令</button></details>`
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

function openNewHost(manual = false) {
  openDrawer({
    title: "添加主机",
    eyebrow: "多节点接入",
    content: manual ? `<button type="button" class="text-button" data-auto-provision>返回 SSH 自动接入</button>${newHostDrawerMarkup()}` : provisioningFormMarkup(),
    saveLabel: manual ? "创建并生成命令" : "一键接入"
  });
}

function clearProvisioningSecrets(form) {
  if (!form) return;
  for (const name of ["password", "privateKey", "passphrase", "sudoPassword"]) {
    if (form.elements[name]) form.elements[name].value = "";
  }
}

function syncProvisioningAuthentication(form) {
  const mode = form.elements.authMethod.value;
  const privateKey = mode === "privateKey";
  form.querySelector("[data-provision-password]").hidden = mode !== "password";
  form.querySelector("[data-provision-key]").hidden = !privateKey;
  form.elements.password.required = mode === "password";
  form.elements.privateKey.required = privateKey;
  if (mode !== "password") form.elements.password.value = "";
  if (!privateKey) { form.elements.privateKey.value = ""; form.elements.passphrase.value = ""; }
  if (mode === "resume") clearProvisioningSecrets(form);
  form.querySelector(".provision-options").hidden = mode === "resume";
}

function syncProvisioningDomain(form) {
  const mode = form.elements.domainMode.value;
  form.querySelector("[data-provision-domain-field]").hidden = mode !== "existing";
  form.elements.endpointDomain.required = mode === "existing";
  if (mode !== "existing") form.elements.endpointDomain.value = "";
  form.querySelector("[data-provision-inherit]").hidden = mode === "none";
}

function canProvision() { return ["owner", "operator"].includes(controlPlane.currentAdmin?.role); }

function clearProvisioning() {
  provisioning.generation += 1;
  clearTimeout(provisioning.timer);
  provisioning.timer = null;
  provisioning.jobs = [];
  provisioning.loading = false;
  provisioning.drawerJobId = null;
  clearProvisioningSecrets(elements.drawerContent.querySelector("#provision-host-form"));
  document.querySelector("#provisioning-jobs")?.replaceChildren();
}

function provisioningFormMarkup(job = null) {
  const field = (label, name, type, attributes = "") => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" ${attributes}><small class="field-error"></small></label>`;
  return `<form class="drawer-form" id="provision-host-form" autocomplete="off" ${job ? `data-job-id="${escapeHtml(job.id)}"` : ""}>
    <div class="drawer-profile"><span class="avatar">${icon("terminal")}</span><div><strong>${job ? "重试原接入任务" : "SSH 自动接入 VPS"}</strong><small>安装 → 心跳 → 协议启用 → 连通与订阅验证</small></div></div>
    ${controlPlane.provisioning?.canStart === false ? `<div class="notice-card" role="alert"><div><strong>请先配置 VPS 可访问的 HTTPS 控制面</strong><p>当前控制面地址 ${escapeHtml(controlPlane.provisioning.controlPlaneOrigin || location.origin)} 尚不满足自动接入条件。本机入口可用于管理；请先在系统访问设置中配置公网 HTTPS 地址，再填写 SSH 登录凭据并接入。</p></div></div>` : ""}
    <p class="field-hint">需要 Linux、systemd 与 root 或 sudo 权限；VPS 必须能访问控制面的公网 HTTPS 地址。始终启用 Shadowsocks 稳定协议；有节点域名时可自动配置 TLS 协议。</p>
    ${job ? `<div class="notice-card"><div><strong>${escapeHtml(job.input.name)}</strong><p>${escapeHtml(job.input.username)}@${escapeHtml(job.input.host)}:${job.input.port} · 保留原任务和 Host；节点已在线时可只继续配置验证。</p></div></div>` : `
      ${field("公网 IP", "host", "text", 'placeholder="填写服务器实际公网 IP 或 IPv6" required spellcheck="false"')}
      <div class="field-grid">${field("SSH 端口", "port", "number", 'value="22" min="1" max="65535" required')}${field("登录用户", "username", "text", 'value="root" required autocomplete="off"')}</div>`}
    <label class="field"><span>${job ? "重试方式" : "登录方式"}</span><select name="authMethod" data-provision-auth><option value="password">密码</option><option value="privateKey">SSH 私钥</option>${job ? '<option value="resume">仅继续配置验证（节点已在线）</option>' : ""}</select></label>
    <div data-provision-password>${field("SSH 密码", "password", "password", 'required autocomplete="new-password"')}</div>
    <div data-provision-key hidden><label class="field"><span>SSH 私钥</span><textarea name="privateKey" rows="6" spellcheck="false" autocomplete="off" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea><small class="field-error"></small></label>${field("私钥口令（可选）", "passphrase", "password", 'autocomplete="new-password"')}</div>
    ${job ? "" : `<p class="drawer-section-label">节点域名与协议</p>
      <label class="field"><span>域名方式</span><select name="domainMode" data-provision-domain><option value="auto">自动分配域名（推荐）</option><option value="existing">使用已解析域名</option><option value="none">仅 IP / Shadowsocks</option></select></label>
      <div data-provision-domain-field hidden>${field("已解析到此 VPS 的域名", "endpointDomain", "text", 'placeholder="node.example.com" spellcheck="false"')}</div>
      <label class="node-domain-option" data-provision-inherit><input name="inheritProtocols" type="checkbox" ${controlPlane.nodeDomains?.inheritProtocols !== false ? "checked" : ""}><span>继承本机可一键启用的公网协议</span></label>
      <p class="field-hint">自动模式使用系统 DNS 设置；未配置或未启用自动域名时只启用 Shadowsocks。已有域名需先解析到此 VPS。TLS 签发依赖系统证书邮箱与公网验证条件；域名不会替换 SSH IP。</p>`}
    <details class="provision-options"><summary>sudo 密码${job ? "" : " / 名称 / 区域（可选）"}</summary>
      ${field("sudo 密码（需要时填写）", "sudoPassword", "password", 'autocomplete="new-password"')}
      ${job ? "" : `${field("名称", "hostname", "text", 'maxlength="80" placeholder="默认 VPS-IP"')}${field("区域标识", "region", "text", 'pattern="[A-Za-z0-9-]{2,32}" placeholder="默认 global"')}<p class="field-hint">仅向“全部节点”或该区域范围内的有效用户自动下发，不改变任何用户权益。</p>`}
    </details>
    <p class="field-hint">登录凭据仅用于本次任务，服务端不保存；任务接受后清空表单。安装未完成或节点离线时，重试需要重新输入凭据。</p>
    ${job ? "" : '<button type="button" class="text-button" data-manual-provision>使用手动接入命令</button>'}
  </form>`;
}

async function submitProvisioningForm(form) {
  if (controlPlane.provisioning?.canStart === false) {
    throw new Error("当前控制面地址不支持自动接入，请先配置 VPS 可访问的 HTTPS 控制面，再提交 SSH 登录凭据。");
  }
  const field = (name) => form.elements[name]?.value || "";
  const authentication = field("authMethod") === "privateKey" ? { privateKey: field("privateKey"), ...(field("passphrase") ? { passphrase: field("passphrase") } : {}) } : { password: field("password") };
  const credentials = field("authMethod") === "resume" ? {} : { ...authentication, ...(field("sudoPassword") ? { sudoPassword: field("sudoPassword") } : {}) };
  if (!form.dataset.requestId) form.dataset.requestId = crypto.randomUUID();
  const body = form.dataset.jobId ? { requestId: form.dataset.requestId, ...credentials } : {
    requestId: form.dataset.requestId, host: field("host").trim(), port: Number(field("port")), username: field("username").trim(),
    domainMode: field("domainMode") || "auto", inheritProtocols: (field("domainMode") || "auto") !== "none" && form.elements.inheritProtocols?.checked !== false,
    ...(field("domainMode") === "existing" ? { endpointDomain: field("endpointDomain").trim() } : {}),
    ...(field("hostname").trim() ? { name: field("hostname").trim() } : {}), ...(field("region").trim() ? { region: field("region").trim() } : {}), ...credentials
  };
  const path = form.dataset.jobId ? `/api/hosts/provision/${encodeURIComponent(form.dataset.jobId)}/retry` : "/api/hosts/provision";
  let response;
  try {
    response = await api(path, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    // Retry has an existing durable identity: resolve an ambiguous response by
    // reading that job before asking the user to send credentials again.
    if (form.dataset.jobId && (!error.status || error.status >= 500 || error.status === 409)) {
      const observed = await api(`/api/hosts/provision/${encodeURIComponent(form.dataset.jobId)}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      if (["queued", "running", "succeeded"].includes(observed?.job?.status)) response = observed;
    }
    if (!response) throw error;
  }
  clearProvisioningSecrets(form);
  return response.job;
}

const provisioningLabels = { queued: "等待接入", running: "正在接入", succeeded: "接入完成", failed: "接入失败", interrupted: "接入中断" };

function provisioningProgressMarkup(job) {
  const completed = job.status === "succeeded";
  return `<div class="drawer-form" data-provisioning-progress="${escapeHtml(job.id)}">
    <div class="drawer-profile"><span class="avatar">${icon("server")}</span><div><strong>${escapeHtml(job.input.name)}</strong><small>${escapeHtml(job.input.host)}:${job.input.port}</small></div></div>
    <h3>${escapeHtml(provisioningLabels[job.status] || job.status)}</h3>
    <progress class="provision-progress" max="100" value="${Number(job.progress) || 0}" aria-label="接入进度"></progress>
    <p role="status" aria-live="polite">${escapeHtml(job.message)} · ${Number(job.progress) || 0}%</p>
    ${job.result?.endpointDomain ? `<p class="field-hint">节点域名：<strong>${escapeHtml(job.result.endpointDomain)}</strong></p>` : ""}
    ${job.errorCode ? `<p class="provision-error">${escapeHtml(job.errorCode)}</p>` : ""}
    ${job.hostKeyFingerprint ? `<p class="field-hint">SSH 指纹 <code class="provision-fingerprint">${escapeHtml(job.hostKeyFingerprint)}</code></p>` : ""}
    ${completed ? `<div class="notice-card"><div><strong>${job.result?.subscriptionStatus === "verified" ? `已验证 ${Number(job.result.verifiedUserCount) || 0} 位用户的订阅` : "等待有效用户"}</strong><p>${job.result?.subscriptionStatus === "verified" ? "有权限的用户刷新客户端订阅后可获得新节点。" : "尚无可用于验证的有效用户；创建或启用符合节点范围的用户后，刷新订阅获取节点。"}</p></div></div>` : ""}
    ${job.result?.skippedProtocols?.length ? `<div class="notice-card"><div><strong>未自动启用的协议</strong>${job.result.skippedProtocols.map((entry) => `<p>${escapeHtml(entry.type)}：${entry.reason === "DOMAIN_REQUIRED" ? "需要节点域名才能启用 TLS" : "需要手动配置，请在主机入口协议中处理"}</p>`).join("")}</div></div>` : ""}
    ${job.result?.protocolChecks?.length ? `<div class="provision-checks">${job.result.protocolChecks.map((check) => `<p><strong>${escapeHtml(check.type)}</strong><span>${escapeHtml(check.state)}${check.latencyMs == null ? "" : ` · ${Number(check.latencyMs)} ms`}</span></p>`).join("")}</div>` : ""}
    ${["failed", "interrupted"].includes(job.status) ? `<button type="button" class="button primary" data-retry-provision="${escapeHtml(job.id)}">重试原任务</button>` : ""}
    ${job.hostId ? `<button type="button" class="button secondary" data-open-host="${escapeHtml(job.hostId)}">查看主机</button>` : ""}
    <p class="field-hint">${["queued", "running"].includes(job.status) ? "关闭此面板后任务继续运行，可在主机页的接入记录中查看结果。" : "结果已保存，可从主机页的接入记录再次查看。"}服务端连通检查不等于移动网络实测。</p>
  </div>`;
}

function openProvisioningJob(job) {
  openDrawer({ title: "自动接入进度", eyebrow: "VPS 自动接入", content: provisioningProgressMarkup(job), saveLabel: "关闭" });
  provisioning.drawerJobId = job.id;
}

function renderProvisioningJobs() {
  const target = document.querySelector("#provisioning-jobs");
  target.innerHTML = provisioning.jobs.length ? provisioning.jobs.map((job) => `<button type="button" class="provision-job" data-open-provision="${escapeHtml(job.id)}"><span><strong>${escapeHtml(job.input.name)}</strong><small>${escapeHtml(job.input.host)} · ${escapeHtml(job.message)}</small></span><span class="status-badge ${job.status === "succeeded" ? "good" : ["failed", "interrupted"].includes(job.status) ? "danger" : "warning"}">${escapeHtml(provisioningLabels[job.status] || job.status)} · ${job.progress}%</span></button>`).join("") : '<p class="field-hint">暂无自动接入记录。</p>';
}

async function loadProvisioningJobs() {
  if (!canProvision() || provisioning.loading || bootstrapRefreshInFlight || controlPlaneConnection.disconnected || document.hidden || navigator.onLine === false) return;
  const generation = provisioning.generation;
  const adminId = controlPlane.currentAdmin.id;
  provisioning.loading = true;
  clearTimeout(provisioning.timer);
  provisioning.timer = null;
  try {
    const { jobs } = await api("/api/hosts/provision", { signal: AbortSignal.timeout(15_000) });
    if (generation !== provisioning.generation || adminId !== controlPlane.currentAdmin?.id || !canProvision()) return;
    const changedToTerminal = jobs.some((job) => !["queued", "running"].includes(job.status) && provisioning.jobs.some((previous) => previous.id === job.id && ["queued", "running"].includes(previous.status)));
    provisioning.jobs = jobs;
    renderProvisioningJobs();
    const current = jobs.find((job) => job.id === provisioning.drawerJobId);
    if (current && elements.drawer.classList.contains("open")) elements.drawerContent.innerHTML = provisioningProgressMarkup(current);
    setText("#provisioning-status", jobs.some((job) => ["queued", "running"].includes(job.status)) ? "接入任务进行中，每 2 秒更新。" : "进度已同步；失败或中断任务可重试，已在线节点可直接继续验证。");
    if (changedToTerminal) await loadBootstrap();
  } catch (error) {
    if (generation !== provisioning.generation) return;
    if (error.status === 401) { showAdminLogin(); return; }
    setText("#provisioning-status", `暂时无法更新接入进度：${error.message}`);
    if (!error.status || error.status >= 500) {
      markControlPlaneDisconnected();
      scheduleBootstrapRefresh();
    }
  } finally {
    if (generation === provisioning.generation) {
      provisioning.loading = false;
      if (canProvision() && !controlPlaneConnection.disconnected && !document.hidden && navigator.onLine !== false && provisioning.jobs.some((job) => ["queued", "running"].includes(job.status))) {
        provisioning.timer = setTimeout(() => loadProvisioningJobs(), 2_000);
      }
    }
  }
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
  const usage = usagePeriodPresentation(user.usagePeriod);
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
        <div class="entitlement-preview">
          <span><small>${usage.usedLabel}</small><strong>${Number(user.usedGb).toFixed(1)} GB</strong></span>
          <span><small>${usage.quotaLabel}</small><strong>${Number(entitlement.quotaGb).toFixed(1)} GB</strong></span>
          <span><small>${usage.monthly ? "本月剩余" : "剩余流量"}</small><strong>${Math.max(0, entitlement.quotaGb - user.usedGb).toFixed(1)} GB</strong></span>
          <span><small>节点范围</small><strong>${escapeHtml(scopeToLabel(entitlement.nodeScope))}</strong></span>
        </div>
        <p class="usage-period-note">${usage.monthly ? "每月 1 日 00:00（北京时间）自动重置。" : ""}${escapeHtml(usage.reset)}</p>
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
    "mihomo-modern": "raylink-mihomo-modern.yaml",
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
    USAGE_PERIOD_CHANGED: "usedGb",
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
    const profile = form.querySelector(".drawer-profile");
    if (profile) profile.after(message);
    else form.prepend(message);
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
    state: form.querySelector("[data-user-enabled]").classList.contains("on") ? "active" : "disabled",
    portalStatus: form.querySelector("[data-portal-enabled]").classList.contains("on") ? "active" : "invited"
  };
  if (!userId || form.elements.usedGb.value !== form.dataset.initialUsedGb) {
    payload.usedGb = Number(form.elements.usedGb.value);
    if (userId && form.dataset.usagePeriodKey) payload.usagePeriodKey = form.dataset.usagePeriodKey;
  }
  if (form.elements.password?.value) payload.password = form.elements.password.value;
  const result = await api(userId ? `/api/users/${encodeURIComponent(userId)}` : "/api/users", {
    method: userId ? "PATCH" : "POST",
    body: JSON.stringify(payload)
  });
  // The write is committed. A failed refresh must not turn a retry into another POST.
  form.dataset.userId = result.id;
  form.dataset.initialUsedGb = form.elements.usedGb.value;
  if (result.usagePeriod?.key) form.dataset.usagePeriodKey = result.usagePeriod.key;
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
  if (["account-profile-form", "account-password-form"].includes(form.id)) {
    if (form.reportValidity()) await savePersonalAccountForm(form);
    return;
  }
  if (!validateDrawerForm(form)) return;

  if (form.id === "provision-host-form") {
    const generation = provisioning.generation;
    const adminId = controlPlane.currentAdmin?.id;
    elements.drawerSave.disabled = true;
    elements.drawerSave.textContent = "提交接入任务…";
    try {
      const job = await submitProvisioningForm(form);
      if (generation !== provisioning.generation || adminId !== controlPlane.currentAdmin?.id || !canProvision()) return;
      provisioning.jobs = [job, ...provisioning.jobs.filter((entry) => entry.id !== job.id)];
      renderProvisioningJobs();
      if (form.isConnected && elements.drawer.classList.contains("open")) openProvisioningJob(job);
      showToast("接入任务已接受", "后台正在安装并验证，关闭面板不影响任务。");
      void loadProvisioningJobs();
    } catch (error) {
      if (generation !== provisioning.generation) return;
      if (error.status === 401) { showAdminLogin(); return; }
      if (form.isConnected) showDrawerFormError(form, error);
      showToast("提交失败", error.message);
      void loadProvisioningJobs();
    } finally {
      if (form.isConnected) {
        elements.drawerSave.disabled = false;
        elements.drawerSave.textContent = form.dataset.jobId ? "重试接入" : "一键接入";
      }
    }
    return;
  }

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
    button.dataset.lastDeploymentId = deployment.id;
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
    try {
      await loadBootstrap();
    } catch {
      showToast("发布已提交", `${deployment.version} 已提交成功，但页面状态刷新失败。请刷新页面核对进度，无需重复发布。`);
      return;
    }
    showToast("发布已提交", `${deployment.version} 已提交，包含 ${deployment.eligibleUsers} 位有效用户。请在部署记录查看各主机结果。`);
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
    button.dataset.lastDeploymentId = deployment.id;
    try {
      await loadBootstrap();
    } catch {
      showToast("回滚已提交", `${deployment.version} 已提交成功，但页面状态刷新失败。请刷新页面核对进度，无需重复回滚。`);
      return;
    }
    showToast("回滚已提交", `已从历史快照创建 ${deployment.version}。请在部署记录查看各主机结果。`);
  } catch (error) {
    showToast("回滚失败", error.message);
  } finally {
    publishInProgress = false;
    button.innerHTML = `${icon("rollback")} 回滚上一版本`;
    button.disabled = !button.dataset.deploymentId;
  }
}

function maintenanceSessionIsCurrent(generation, adminId) {
  return generation === controlPlaneConnection.generation && adminId === controlPlane.currentAdmin?.id;
}

async function syncRuntimeCertificates() {
  if (certificateSyncRunning) return;
  const generation = controlPlaneConnection.generation, adminId = controlPlane.currentAdmin?.id;
  certificateSyncRunning = true;
  renderCertificateRenewal();
  try {
    const result = await api("/api/runtime/certificates/sync", { method: "POST" });
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    controlPlane.tlsRenewal = result;
    showToast(result.status === "error" ? "证书同步失败" : "证书检查完成", result.status === "error" ? result.errorCode : result.changed ? "新证书已应用并验证。" : "当前证书无需更新。");
    await loadBootstrap();
  } catch (error) {
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    showToast("证书检查失败", error.message);
  } finally {
    certificateSyncRunning = false;
    if (maintenanceSessionIsCurrent(generation, adminId)) renderCertificateRenewal();
  }
}

async function checkSystemUpdate() {
  if (systemUpdateRequest.checking) return;
  const generation = controlPlaneConnection.generation, adminId = controlPlane.currentAdmin?.id;
  systemUpdateRequest.checking = true;
  systemUpdateRequest.error = "";
  renderSystemUpdate();
  try {
    const result = await api("/api/system/update", { signal: AbortSignal.timeout(30_000) });
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    controlPlane.systemUpdate = result.systemUpdate || result;
  } catch (error) {
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    if (error.status === 401) { showAdminLogin(); return; }
    systemUpdateRequest.error = `检查失败：${error.message}`;
  } finally {
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    systemUpdateRequest.checking = false;
    renderSystemUpdate();
  }
}

async function upgradeSystem() {
  if (!systemUpdatePresentation().canUpgrade) return;
  if (!window.confirm("更新 RayLink 主控会短暂重启管理服务。现有节点继续运行；页面恢复连接后请核对更新结果。确认继续？")) return;
  const generation = controlPlaneConnection.generation, adminId = controlPlane.currentAdmin?.id;
  systemUpdateRequest.upgrading = true;
  systemUpdateRequest.error = "";
  renderSystemUpdate();
  try {
    const result = await api("/api/system/upgrade", { method: "POST" });
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    controlPlane.systemUpdate = { ...controlPlane.systemUpdate, ...(result.systemUpdate || result) };
    showToast("主控更新已接受", "等待后台更新与重启完成，页面会自动恢复连接并读取最终结果。");
    try { await loadBootstrap(); } catch { /* Restart can temporarily interrupt the read. */ }
  } catch (error) {
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    if (error.status === 401) { showAdminLogin(); return; }
    systemUpdateRequest.error = !error.status ? "请求中断，更新是否已接受尚未确认。请重连后查看后台任务状态，再决定是否重试。" : error.message;
    showToast("主控更新结果待确认", systemUpdateRequest.error);
  } finally {
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    systemUpdateRequest.upgrading = false;
    renderSystemUpdate();
  }
}

async function upgradeNode(hostId, button) {
  const host = controlPlane.hosts.find(item => item.id === hostId);
  if (!host || button?.disabled || controlPlane.currentAdmin?.role !== "owner"
    || !nodeVersionSupports(host.agentVersion, "0.9.0") || host.nodeUpgrade?.supported === false || host.nodeUpgrade?.pending || host.status !== "online") return;
  if (!window.confirm("更新该主机的 RayLink Node 管理服务，现有 sing-box 连接继续运行。确认继续？")) return;
  const generation = controlPlaneConnection.generation, adminId = controlPlane.currentAdmin?.id;
  if (button) { button.disabled = true; button.textContent = "正在下发更新…"; }
  try {
    await api(`/api/hosts/${encodeURIComponent(hostId)}/node-upgrade`, { method: "POST" });
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    host.nodeUpgrade = { ...host.nodeUpgrade, pending: true, status: "queued", message: "更新任务已下发，等待节点执行并以心跳确认版本。" };
    renderSystemUpdate();
    showToast("Node 更新任务已下发", "等待节点执行；最终结果以版本心跳和任务状态为准。");
    try { await loadBootstrap(); } catch { /* Preserve the accepted task state. */ }
  } catch (error) {
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    if (error.status === 401) { showAdminLogin(); return; }
    showToast("Node 更新未完成", error.message);
  } finally {
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    if (button) { button.disabled = false; button.textContent = "重试 Node 更新"; }
    renderSystemUpdate();
  }
}

async function configureHostBbr(hostId, button) {
  if (button?.disabled) return;
  const host = controlPlane.hosts.find(item => item.id === hostId);
  if (!host || !hostBbrPresentation(host).canConfigure) return;
  const generation = controlPlaneConnection.generation, adminId = controlPlane.currentAdmin?.id;
  const previous = button?.innerHTML;
  if (button) { button.disabled = true; button.innerHTML = `${icon("refresh")}正在配置 BBR`; }
  try {
    const result = await api(`/api/hosts/${encodeURIComponent(hostId)}/bbr`, { method: "POST" });
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    if (host.kind !== "remote") controlPlane.bbr = result.bbr || result;
    else host.bbrTask = { pending: true, status: "pending" };
    let refreshWarning = "";
    try { await loadBootstrap(); } catch { refreshWarning = "状态刷新暂时失败，请稍后刷新主机诊断。"; }
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    if (host.kind === "remote") {
      showToast("BBR 配置任务已下发", `等待节点执行与心跳确认。${refreshWarning}`);
    } else {
      const state = result.bbr || result;
      showToast(state.status === "enabled" ? "BBR 已启用" : "BBR 尚未启用", `${state.error || (state.status === "enabled" ? "已读取内核状态确认 TCP 拥塞控制。" : "请检查内核能力和系统权限后重试。")}${refreshWarning}`);
    }
    if (!refreshWarning && elements.drawer?.classList.contains("open")) openHost(hostId);
  } catch (error) {
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    if (error.status === 401) { showAdminLogin(); return; }
    showToast("BBR 配置失败", error.message);
  } finally {
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    if (button) { button.disabled = false; button.innerHTML = previous; }
    renderSystemUpdate();
  }
}

async function installSingBox() {
  if (runtimeSetupRequest.running || controlPlane.runtimeSetup?.status === "running"
    || runtimeSetupPresentation().blocked || !["owner", "operator"].includes(controlPlane.currentAdmin?.role)) return;
  const generation = controlPlaneConnection.generation, adminId = controlPlane.currentAdmin?.id;
  runtimeSetupRequest.running = true;
  runtimeSetupRequest.error = "";
  renderRuntimeSetup();
  try {
    const result = await api("/api/runtime/install", { method: "POST" });
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    if (result.runtimeSetup) controlPlane.runtimeSetup = result.runtimeSetup;
    else if (result.setup) controlPlane.runtimeSetup = result.setup;
    else if (result.status) controlPlane.runtimeSetup = result;
    let refreshWarning = "";
    try { await loadBootstrap(); } catch { refreshWarning = " 最新运行状态暂时无法读取，请稍后刷新确认。"; }
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    runtimeSetupRequest.running = false;
    const presentation = runtimeSetupPresentation();
    showToast(presentation.title, `${presentation.message}${refreshWarning}`);
  } catch (error) {
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    if (error.status === 401) { showAdminLogin(); return; }
    runtimeSetupRequest.error = error.message;
    showToast("安装配置未完成", error.message);
  } finally {
    if (!maintenanceSessionIsCurrent(generation, adminId)) return;
    runtimeSetupRequest.running = false;
    renderRuntimeSetup();
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
  if (!button || button.hidden || button.disabled || controlPlane.runtime?.mode !== "systemd") return;
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

document.addEventListener("change", (event) => {
  if (event.target.matches("[data-provision-auth]")) syncProvisioningAuthentication(event.target.form);
  if (event.target.matches("[data-provision-domain]")) syncProvisioningDomain(event.target.form);
});
document.addEventListener("submit", (event) => {
  if (event.target.id === "provision-host-form" || event.target.matches("[data-personal-account]")) { event.preventDefault(); if (!elements.drawerSave.disabled) void saveDrawer(); }
});

document.addEventListener("click", async (event) => {
  if (event.target.closest("[data-reconnect-control-plane]")) { await reconnectControlPlane(); return; }
  if (event.target.closest("[data-open-account]")) { openPersonalAccount(); return; }
  const accountMode = event.target.closest("[data-account-mode]");
  if (accountMode) { openPersonalAccount(accountMode.dataset.accountMode); return; }
  const logoutButton = event.target.closest("[data-logout]");
  if (logoutButton) {
    await logoutControlPlane(logoutButton);
    return;
  }

  if (event.target.closest("#profile-menu-trigger")) {
    setProfileMenu(elements.profileMenu.hidden);
    if (!elements.profileMenu.hidden) elements.profileMenu.querySelector("button").focus();
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
    const adminId = controlPlane.currentAdmin?.id;
    await loadNodeDomainSettings();
    if (adminId === controlPlane.currentAdmin?.id && canProvision()) openNewHost();
    return;
  }

  if (event.target.closest("[data-manual-provision]")) { openNewHost(true); return; }
  if (event.target.closest("[data-auto-provision]")) { openNewHost(); return; }
  if (event.target.closest("[data-refresh-provisioning]")) { await loadProvisioningJobs(); return; }
  const jobButton = event.target.closest("[data-open-provision]");
  if (jobButton) {
    const job = provisioning.jobs.find((entry) => entry.id === jobButton.dataset.openProvision);
    if (job) openProvisioningJob(job);
    return;
  }
  const retryJobButton = event.target.closest("[data-retry-provision]");
  if (retryJobButton) {
    const job = provisioning.jobs.find((entry) => entry.id === retryJobButton.dataset.retryProvision);
    if (job) openDrawer({ title: "重试自动接入", eyebrow: "保留原 Host", content: provisioningFormMarkup(job), saveLabel: "重试接入" });
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
    if (policyTab.dataset.policyTab === "ai") loadAiDiagnostics();
    return;
  }

  const deleteRoutingRule = event.target.closest("[data-routing-rule-delete]");
  if (deleteRoutingRule) {
    if (!canManageRoutingPolicy() || routingPolicySaving) return;
    try {
      await persistRoutingPolicy(
        {
          ...controlPlane.routingPolicy,
          rules: controlPlane.routingPolicy.rules.filter(
            (rule) => rule.id !== deleteRoutingRule.dataset.routingRuleDelete
          )
        },
        "规则已删除，完整订阅将使用新的规则顺序。"
      );
    } catch (error) {
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
    if (systemTab.dataset.systemTab === "certificates") await loadNodeDomainSettings();
    if (systemTab.dataset.systemTab === "hosts") await loadProvisioningJobs();
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

  if (event.target.closest("[data-check-system-update]")) { await checkSystemUpdate(); return; }
  if (event.target.closest("[data-upgrade-system]")) { await upgradeSystem(); return; }
  const nodeUpgradeButton = event.target.closest("[data-upgrade-node]");
  if (nodeUpgradeButton) { await upgradeNode(nodeUpgradeButton.dataset.upgradeNode, nodeUpgradeButton); return; }

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

  const bbrButton = event.target.closest("[data-configure-bbr]");
  if (bbrButton) {
    await configureHostBbr(bbrButton.dataset.configureBbr, bbrButton);
    return;
  }

  const saveAdminButton = event.target.closest("[data-save-admin]");
  if (saveAdminButton) {
    await saveAdministrator(saveAdminButton.dataset.saveAdmin);
    return;
  }

  if (event.target.closest("#install-sing-box, [data-install-runtime]")) {
    await installSingBox();
    return;
  }

  if (event.target.closest("#sync-runtime-certificates")) {
    await syncRuntimeCertificates();
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
        : target.id === "mcp-endpoint" ? "MCP Server Endpoint 已复制。" : "内容已复制到剪贴板。"
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
document.querySelector("#node-domain-settings-form").addEventListener("submit", saveNodeDomainSettings);
document.querySelector("#node-domain-provider").addEventListener("change", syncNodeDomainProvider);
document.querySelector("#admin-create-form")?.addEventListener("submit", createAdministrator);
document.querySelector("#mcp-create-form").addEventListener("submit", createMcpCredential);
document.querySelector("#mcp-scope-list").addEventListener("change", () => {
  document.querySelectorAll("[data-mcp-preset]").forEach((button) => button.setAttribute("aria-pressed", "false"));
});
document.querySelector("#routing-mode-form")?.addEventListener("submit", saveRoutingMode);
document.querySelector("#routing-rule-form")?.addEventListener("submit", addRoutingRule);
document.querySelector("#routing-diagnose-form")?.addEventListener("submit", diagnoseRouting);
document.querySelector("#ai-diagnose-form")?.addEventListener("submit", diagnoseAiServices);
document.querySelector("#ai-egress-form")?.addEventListener("submit", saveAiEgress);
for (const eventName of ["input", "change"]) document.querySelector("#ai-egress-form")?.addEventListener(eventName, () => {
  aiEgressDirty = true;
  aiEgressError = "";
  renderAiEgress();
});
document.querySelector("#ai-egress-publish")?.addEventListener("click", publishAiEgress);

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

function renderControlPlaneConnection() {
  const notice = document.querySelector("#connection-notice");
  notice.hidden = !controlPlaneConnection.disconnected;
  setText("#connection-title", "无法连接控制面服务");
  const retry = navigator.onLine === false ? "网络已离线，重新联网后将重连。" : "将自动重试，也可立即重连。";
  setText("#connection-copy", `当前地址 ${location.origin}。页面数据可能已过期，请检查服务是否运行。${retry}SSH 接入表单内容会保留。`);
  const button = document.querySelector("[data-reconnect-control-plane]");
  button.disabled = bootstrapRefreshInFlight;
  button.textContent = bootstrapRefreshInFlight ? "正在重连…" : "立即重连";
}

function markControlPlaneDisconnected() {
  controlPlaneConnection.disconnected = true;
  clearTimeout(provisioning.timer);
  provisioning.timer = null;
  renderControlPlaneConnection();
}

function stopControlPlaneRefresh() {
  controlPlaneConnection.active = false;
  controlPlaneConnection.generation += 1;
  controlPlaneConnection.controller?.abort();
  controlPlaneConnection.controller = null;
  bootstrapReadPromise = null;
  bootstrapRefreshInFlight = false;
  bootstrapRefreshPromise = null;
  clearTimeout(bootstrapRefreshTimer);
  bootstrapRefreshTimer = null;
  controlPlaneConnection.disconnected = false;
  controlPlaneConnection.failures = 0;
  renderControlPlaneConnection();
}

function scheduleBootstrapRefresh(delay = 10_000) {
  clearTimeout(bootstrapRefreshTimer);
  bootstrapRefreshTimer = null;
  if (!controlPlaneConnection.active || document.hidden || navigator.onLine === false) return;
  bootstrapRefreshTimer = setTimeout(() => {
    bootstrapRefreshTimer = null;
    return refreshControlPlane();
  }, delay);
}

async function refreshControlPlane() {
  if (!controlPlaneConnection.active || document.hidden || navigator.onLine === false) return;
  if (bootstrapRefreshInFlight) return bootstrapRefreshPromise;
  // Let an in-flight progress read finish before starting another background read.
  if (provisioning.loading) { scheduleBootstrapRefresh(1_000); return; }
  const generation = controlPlaneConnection.generation;
  const recovering = controlPlaneConnection.disconnected;
  clearTimeout(bootstrapRefreshTimer);
  bootstrapRefreshTimer = null;
  clearTimeout(provisioning.timer);
  provisioning.timer = null;
  bootstrapRefreshInFlight = true;
  renderControlPlaneConnection();
  const request = (async () => {
    let delay = 10_000;
    let refreshed = false;
    try {
      await loadBootstrap({ share: true });
      if (generation !== controlPlaneConnection.generation) return;
      if (navigator.onLine === false) { markControlPlaneDisconnected(); return; }
      controlPlaneConnection.disconnected = false;
      controlPlaneConnection.failures = 0;
      refreshed = true;
      if (elements.appShell.hidden) displayControlPlane();
    } catch (error) {
      if (generation !== controlPlaneConnection.generation) return;
      if (error.status === 401) { stopControlPlaneRefresh(); showAdminLogin(); return; }
      controlPlaneConnection.failures += 1;
      delay = Math.min(60_000, 10_000 * (2 ** Math.min(controlPlaneConnection.failures - 1, 3)));
      markControlPlaneDisconnected();
    } finally {
      if (generation === controlPlaneConnection.generation) {
        bootstrapRefreshInFlight = false;
        renderControlPlaneConnection();
        if (refreshed && (recovering || provisioning.jobs.some((job) => ["queued", "running"].includes(job.status)))) await loadProvisioningJobs();
        scheduleBootstrapRefresh(delay);
      }
    }
  })();
  bootstrapRefreshPromise = request;
  try { return await request; }
  finally { if (bootstrapRefreshPromise === request) bootstrapRefreshPromise = null; }
}

function displayControlPlane() {
  elements.authScreen.hidden = true;
  elements.appShell.hidden = false;
  elements.mobileNav.hidden = false;
  elements.authError.textContent = "";
  syncResponsiveNavigation();
  const initialRoute = location.hash.replace(/^#\//, "") || "dashboard";
  navigate(initialRoute, false);
}

async function reconnectControlPlane() {
  if (!controlPlaneConnection.active && !controlPlaneConnection.disconnected) return;
  controlPlaneConnection.active = true;
  if (navigator.onLine === false) { markControlPlaneDisconnected(); return; }
  return refreshControlPlane();
}

function handleControlPlaneConnectivityChange() {
  if (!controlPlaneConnection.active) return;
  if (document.hidden || navigator.onLine === false) {
    clearTimeout(bootstrapRefreshTimer);
    bootstrapRefreshTimer = null;
    clearTimeout(provisioning.timer);
    provisioning.timer = null;
    if (navigator.onLine === false) markControlPlaneDisconnected();
    return;
  }
  return reconnectControlPlane();
}

window.addEventListener("online", handleControlPlaneConnectivityChange);
window.addEventListener("offline", handleControlPlaneConnectivityChange);
document.addEventListener("visibilitychange", handleControlPlaneConnectivityChange);

async function initializeControlPlane() {
  const generation = controlPlaneConnection.generation;
  try {
    await enterControlPlane();
  } catch (error) {
    if (generation !== controlPlaneConnection.generation) return;
    if (error.status !== 401) {
      elements.authError.textContent = `无法连接控制面 ${location.origin}，请确认服务已启动后重连。`;
      controlPlaneConnection.active = true;
      markControlPlaneDisconnected();
      scheduleBootstrapRefresh();
    }
    elements.authScreen.hidden = false;
    elements.appShell.hidden = true;
  }
}

async function enterControlPlane() {
  const generation = controlPlaneConnection.generation;
  await loadBootstrap();
  if (generation !== controlPlaneConnection.generation) return;
  controlPlaneConnection.active = true;
  controlPlaneConnection.disconnected = false;
  controlPlaneConnection.failures = 0;
  renderControlPlaneConnection();
  displayControlPlane();
  void loadProvisioningJobs();
  scheduleBootstrapRefresh();
}

elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  stopControlPlaneRefresh();
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

void initializeControlPlane();
