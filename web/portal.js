const loginPanel = document.querySelector("#portal-login-panel");
const accountPanel = document.querySelector("#portal-account-panel");
const loginForm = document.querySelector("#standalone-portal-login");
const loginError = document.querySelector("#portal-login-error");
const downloadButton = document.querySelector("#portal-download-config");
const subscriptionAction = document.querySelector("#portal-subscription-action");
const subscriptionStatus = document.querySelector("#portal-subscription-status");
const subscriptionValue = document.querySelector("#portal-subscription-value");
const subscriptionUrl = document.querySelector("#portal-subscription-url");
const copySubscription = document.querySelector("#portal-copy-subscription");
const subscriptionQr = document.querySelector("#portal-subscription-qr");
const importMihomo = document.querySelector("#portal-import-mihomo");
const importMihomoModern = document.querySelector("#portal-import-mihomo-modern");
const importLoon = document.querySelector("#portal-import-loon");
const importEgern = document.querySelector("#portal-import-egern");
const importEgernNodes = document.querySelector("#portal-import-egern-nodes");
const downloadSingBox = document.querySelector("#portal-download-singbox");
const subscriptionClientUrl = window.RayLinkSubscriptionClientUrl;
let subscriptionLoadRequest = 0;

async function portalApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || "请求失败");
  return body;
}

function scopeLabel(scope) {
  const labels = { all: "全部节点", tokyo: "东京", singapore: "新加坡" };
  if (scope.includes("all")) return labels.all;
  return scope.map((item) => labels[item] || item).join(" + ");
}

function usagePeriodPresentation(period) {
  const resetsAt = typeof period?.resetsAt === "string" ? new Date(period.resetsAt) : null;
  const monthly = period?.timeZone === "Asia/Shanghai"
    && /^\d{4}-(0[1-9]|1[0-2])$/.test(period.key || "")
    && /(?:Z|[+-]\d{2}:\d{2})$/i.test(period.resetsAt || "")
    && resetsAt && Number.isFinite(resetsAt.getTime());
  return {
    monthly: Boolean(monthly),
    reset: monthly
      ? `下次重置（北京时间）：${new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).format(resetsAt)}`
      : "未收到月度周期信息，自动重置状态待确认。"
  };
}

function renderAccount(profile) {
  const { user, entitlement } = profile;
  const usage = usagePeriodPresentation(user.usagePeriod);
  document.querySelector("#portal-user-initials").textContent = user.initials;
  document.querySelector("#portal-user-name").textContent = user.name;
  document.querySelector("#portal-user-email").textContent = user.email;
  document.querySelector("#portal-account-title").textContent = `${user.name} 的访问权益`;
  document.querySelector("#portal-used-label").textContent = usage.monthly ? "本月已用" : "已用流量";
  document.querySelector("#portal-quota-label").textContent = usage.monthly ? "每月额度" : "流量额度";
  document.querySelector("#portal-remaining-label").textContent = usage.monthly ? "本月剩余" : "剩余流量";
  document.querySelector("#portal-used-quota").textContent = `${Number(user.usedGb).toFixed(1)} GB`;
  document.querySelector("#portal-monthly-quota").textContent = `${Number(entitlement.quotaGb).toFixed(1)} GB`;
  document.querySelector("#portal-remaining-quota").textContent = `${Math.max(0, entitlement.quotaGb - user.usedGb).toFixed(1)} GB`;
  document.querySelector("#portal-usage-period").textContent = `${usage.monthly ? "每月 1 日 00:00（北京时间）自动重置。" : ""}${usage.reset}`;
  document.querySelector("#portal-node-scope").textContent = scopeLabel(entitlement.nodeScope);
  downloadButton.hidden = false;
  const configured = Boolean(user.subscription?.configured);
  subscriptionAction.dataset.configured = String(configured);
  subscriptionAction.textContent = configured ? "重新生成订阅地址" : "生成订阅地址";
  subscriptionStatus.textContent = configured
    ? user.subscription?.recoverable
      ? "正在读取现有订阅地址…"
      : "现有地址由旧版本生成，需要重新生成一次；之后可随时查看。"
    : "生成后可导入 Clash/Mihomo、Loon、Egern 或 sing-box；地址保持有效，直到你主动重置。";
  loginPanel.hidden = true;
  accountPanel.hidden = false;
  if (configured && user.subscription?.recoverable) {
    loadCurrentSubscription();
  } else {
    subscriptionValue.hidden = true;
  }
}

function revealSubscription(url, existing = false) {
  subscriptionUrl.value = url;
  subscriptionValue.hidden = false;
  const formatUrl = (format) => subscriptionClientUrl.forFormat(url, format);
  importMihomo.href = `clash://install-config?url=${encodeURIComponent(formatUrl("mihomo"))}&name=RayLink`;
  importMihomoModern.href = `clash://install-config?url=${encodeURIComponent(formatUrl("mihomo-modern"))}&name=RayLink`;
  importLoon.href = formatUrl("loon");
  importEgern.href = `egern:/profiles/new?name=RayLink&url=${encodeURIComponent(formatUrl("egern-profile"))}`;
  importEgernNodes.href = `egern:/subscriptions/new?url=${encodeURIComponent(formatUrl("egern"))}`;
  downloadSingBox.href = formatUrl("singbox");
  const qrReady = window.RayLinkSubscriptionQr?.render(subscriptionQr, url) === true;
  subscriptionStatus.textContent = existing
    ? qrReady
      ? "现有订阅地址已载入，可复制或扫描二维码。"
      : "现有订阅地址已载入，二维码暂不可用，请复制链接。"
    : qrReady
      ? "新地址已生成并加密保存，之后可随时查看。"
      : "新地址已生成并加密保存，二维码暂不可用，请复制链接。";
}

async function loadCurrentSubscription() {
  const requestId = ++subscriptionLoadRequest;
  try {
    const result = await portalApi("/api/portal/subscription");
    if (requestId === subscriptionLoadRequest) {
      revealSubscription(result.subscriptionUrl, true);
    }
  } catch (error) {
    if (requestId === subscriptionLoadRequest) {
      subscriptionStatus.textContent = error.message;
      subscriptionValue.hidden = true;
    }
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const submit = loginForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "登录中…";
  try {
    const profile = await portalApi("/api/portal/login", {
      method: "POST",
      body: JSON.stringify({
        email: loginForm.elements.email.value.trim(),
        password: loginForm.elements.password.value
      })
    });
    loginForm.elements.password.value = "";
    renderAccount(profile);
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = "登录";
  }
});

downloadButton.addEventListener("click", async () => {
  downloadButton.disabled = true;
  downloadButton.textContent = "正在生成…";
  try {
    const response = await fetch("/api/portal/config/sing-box");
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body?.error?.message || "配置生成失败");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "raylink-sing-box.json";
    anchor.click();
    URL.revokeObjectURL(url);
    document.querySelector("#portal-download-note").textContent = "配置已生成。请妥善保管，其中包含你的专属运行凭据。";
  } catch (error) {
    document.querySelector("#portal-download-note").textContent = error.message;
  } finally {
    downloadButton.disabled = false;
    downloadButton.textContent = "下载 sing-box 高级配置";
  }
});

subscriptionAction.addEventListener("click", async () => {
  const isReset = subscriptionAction.dataset.configured === "true";
  if (isReset && !window.confirm("重新生成后，已经导入客户端的旧订阅地址会立即失效。确定继续吗？")) return;

  subscriptionAction.disabled = true;
  subscriptionAction.textContent = isReset ? "正在重新生成…" : "正在生成…";
  try {
    const result = await portalApi("/api/portal/subscription/rotate", { method: "POST" });
    subscriptionLoadRequest += 1;
    revealSubscription(result.subscriptionUrl);
    subscriptionAction.dataset.configured = "true";
    subscriptionAction.textContent = "重新生成订阅地址";
  } catch (error) {
    subscriptionStatus.textContent = error.message;
    subscriptionAction.textContent = isReset ? "重新生成订阅地址" : "生成订阅地址";
  } finally {
    subscriptionAction.disabled = false;
  }
});

copySubscription.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(subscriptionUrl.value);
    copySubscription.textContent = "已复制";
    window.setTimeout(() => { copySubscription.textContent = "复制"; }, 1600);
  } catch {
    subscriptionUrl.focus();
    subscriptionUrl.select();
    copySubscription.textContent = "请手动复制";
  }
});

portalApi("/api/portal/me").then(renderAccount).catch(() => {
  loginPanel.hidden = false;
  accountPanel.hidden = true;
});
