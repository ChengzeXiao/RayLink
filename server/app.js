import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { BbrManager } from "./bbr.js";
import { RuntimeSetupManager } from "./runtime-setup.js";
import { SystemUpdateManager } from "./system-update.js";
import { BackupManager } from "./backup.js";
import { evaluateOperationalAlerts } from "./alerts.js";
import { buildReadinessReport } from "./readiness.js";
import { AlertWebhookDispatcher } from "./alert-dispatcher.js";
import { normalizeCertificateEmail } from "./certificate-settings.js";
import { RayLinkStore } from "./database.js";
import { McpCredentials, MCP_SCOPES } from "./mcp-credentials.js";
import { createMcpService } from "./mcp.js";
import { NodeProvisioning } from "./node-provisioning.js";
import { NodeDomains } from "./node-domains.js";
import { diagnoseRoutingDomain } from "./routing/diagnostics.js";
import { getBundledRoutingVersion } from "./routing/rule-sets/bundled.js";
import { validateNodeEncryptionPublicKey } from "./node-secrets.js";
import {
  ProtocolActivationManager,
  protocolActivationPolicy,
  UfwFirewallManager
} from "./protocol-activation.js";
import { CaddySetupAccessManager } from "./setup-access.js";
import { buildUserClientConfig } from "./singbox/client-config.js";
import {
  APPROVED_METERED_RUNTIME_VERSION,
  SingBoxInstaller
} from "./singbox/installer.js";
import { LocalSingBoxAdapter } from "./singbox/local-adapter.js";
import { ManagedRuleSetCache } from "./singbox/rule-set-cache.js";
import {
  protocolAvailability,
  protocolCatalog
} from "./singbox/protocol-catalog.js";
import { RuntimeManager } from "./singbox/runtime-manager.js";
import { LocalTelemetryCollector } from "./telemetry.js";
import {
  LocalTlsAssetStager,
  RemoteTlsAssetPackager
} from "./tls-assets.js";
import {
  systemdRuntimeInstanceId,
  V2RayStatsCollector
} from "./usage/v2ray-stats.js";
import { buildSubscriptionArtifact } from "./subscriptions/formats.js";
import { EndpointResolver } from "./subscriptions/endpoint-resolver.js";
import {
  buildSubscriptionFormatUrls,
  resolveSubscriptionFormat,
  subscriptionFormatForPath,
  subscriptionFormatForUserAgent,
  subscriptionPathSuffixPattern,
  subscriptionPortalAliasPattern
} from "./subscriptions/catalog.js";

const SESSION_COOKIE = "raylink_session";
const PORTAL_SESSION_COOKIE = "raylink_portal_session";
const REQUIRED_NODE_AGENT_VERSION = "0.7.0";
const RUNTIME_UPGRADE_NODE_VERSION = "0.8.0";
const CURRENT_NODE_VERSION = "0.9.0";
const SUPPORTED_NODE_VERSIONS = [REQUIRED_NODE_AGENT_VERSION, RUNTIME_UPGRADE_NODE_VERSION, CURRENT_NODE_VERSION];
const supportsNodeMaintenance = (version) => /^\d+\.\d+\.\d+$/.test(version || "") && !versionIsOlder(version, "0.9.0");
const defaultWebDir = fileURLToPath(new URL("../web", import.meta.url));
const rolePermissions = new Map([
  ["owner", new Set(["read", "users.manage", "runtime.manage", "system.manage", "admins.manage", "audit.read"])],
  ["operator", new Set(["read", "users.manage", "runtime.manage", "audit.read"])],
  ["support", new Set(["read", "users.manage"])],
  ["auditor", new Set(["read", "audit.read"])]
]);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml"
};

function adminPermissionForRequest(method, pathname) {
  if (method === "POST" && pathname === "/api/account/password") return "read";
  if (method === "PATCH" && pathname === "/api/account/profile") return "read";
  if (pathname === "/api/mcp/tokens" || pathname.startsWith("/api/mcp/tokens/")) return "admins.manage";
  if (pathname === "/api/admins" || pathname.startsWith("/api/admins/")) {
    return "admins.manage";
  }
  if (pathname === "/api/audit") return "audit.read";
  if (["GET", "HEAD"].includes(method)) return "read";
  if (/^\/api\/hosts\/[^/]+\/node-upgrade$/.test(pathname)) return "system.manage";
  if (pathname === "/api/users" || pathname.startsWith("/api/users/")) {
    return "users.manage";
  }
  if (
    pathname === "/api/runtime"
    || pathname.startsWith("/api/runtime/")
    || pathname === "/api/hosts"
    || pathname.startsWith("/api/hosts/")
    || pathname === "/api/deployments"
    || pathname.startsWith("/api/deployments/")
    || pathname === "/api/settings/routing"
    || pathname === "/api/routing/diagnose"
  ) {
    return "runtime.manage";
  }
  return "system.manage";
}

function auditResource(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  return {
    resourceType: parts[1] || "system",
    resourceId: parts[2] || null
  };
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").flatMap((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 0) return [];
    return [[entry.slice(0, separator).trim(), decodeURIComponent(entry.slice(separator + 1).trim())]];
  }));
}

function bearerToken(header = "") {
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

async function readJson(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("请求内容过大");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求不是有效的 JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers
  });
  response.end(payload);
}

function httpError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
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

function subscriptionUserInfo(user) {
  const usedBytes = Math.max(
    0,
    Math.round(
      user.usedBytes === undefined
        ? (Number(user.usedGb) || 0) * (1024 ** 3)
        : Number(user.usedBytes) || 0
    )
  );
  const totalBytes = Math.max(0, Math.round((Number(user.quotaGb) || 0) * (1024 ** 3)));
  const expiresAt = new Date(`${user.expiresAt}T23:59:59.999Z`);
  const expire = Number.isFinite(expiresAt.getTime())
    ? Math.floor(expiresAt.getTime() / 1000)
    : 0;
  return `upload=0; download=${usedBytes}; total=${totalBytes}; expire=${expire}`;
}

function sendSubscriptionArtifact(request, response, artifact, user) {
  const payload = artifact.body;
  const userInfo = subscriptionUserInfo(user);
  const etag = `"${createHash("sha256")
    .update(payload)
    .update("\0")
    .update(userInfo)
    .digest("hex")}"`;
  const headers = {
    "cache-control": "private, no-cache",
    "content-type": artifact.contentType,
    "content-length": Buffer.byteLength(payload),
    "content-disposition": `attachment; filename="${artifact.filename}"`,
    etag,
    "subscription-userinfo": userInfo,
    "referrer-policy": "no-referrer",
    vary: "User-Agent, Accept",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow"
  };
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, headers);
  endRequestPayload(request, response, payload);
}

function endRequestPayload(request, response, payload) {
  response.end(request.method === "HEAD" ? undefined : payload);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sendSubscriptionLanding(request, response, subscriptionUrl) {
  const {
    mihomo: mihomoUrl,
    egern: egernUrl,
    egernProfile: egernProfileUrl,
    singbox: singBoxUrl
  } = buildSubscriptionFormatUrls(subscriptionUrl);
  const egernImport = `egern:/subscriptions/new?url=${encodeURIComponent(egernUrl)}`;
  const egernProfileImport = `egern:/profiles/new?name=RayLink&url=${encodeURIComponent(egernProfileUrl)}`;
  const clashImport = `clash://install-config?url=${encodeURIComponent(mihomoUrl)}&name=RayLink`;
  const payload = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>RayLink 客户端订阅</title>
  <style>
    :root{color-scheme:dark;font-family:Bahnschrift,"DIN Alternate","Avenir Next","PingFang SC",system-ui,sans-serif;background:#050907;color:#edf7f1}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px}
    main{width:min(820px,100%);border:1px solid #20342a;border-radius:12px;background:#0a100d;padding:34px}
    h1{margin:8px 0 10px;font-size:32px}p{color:#99aaa1;line-height:1.7}.eyebrow{color:#7ee2a5;font-size:12px;letter-spacing:.14em}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:28px 0}
    a,.client-card{display:block;min-height:40px;border:1px solid #263d31;border-radius:8px;padding:16px;color:#edf7f1;text-decoration:none;background:#0e1712}
    a:hover{border-color:#75d99b;background:#122218}a strong,.client-card strong{display:block;margin-bottom:4px}a small,.client-card small{color:#91a49a}
    .client-card code{display:block;margin-top:8px;color:#7ee2a5;font-size:11px;overflow-wrap:anywhere;user-select:all}
    footer{border-top:1px solid #1b2b23;padding-top:18px;color:#718278;font-size:13px}
    @media(max-width:650px){.grid{grid-template-columns:1fr}main{padding:24px}}
  </style>
</head>
<body>
  <main>
    <span class="eyebrow">RAYLINK UNIVERSAL SUBSCRIPTION</span>
    <h1>选择你的客户端</h1>
    <p>这是通用订阅入口。RayLink 会为不同客户端生成兼容配置；订阅地址包含访问凭据，请勿转发。</p>
    <div class="grid">
      <a href="${escapeHtml(clashImport)}"><strong>Clash Verge Rev / Mihomo</strong><small>Windows、macOS、Linux · 一键导入</small></a>
      <div class="client-card"><strong>Loon 节点订阅</strong><small>复制下面的通用地址，在 Loon 中添加订阅</small><code>${escapeHtml(subscriptionUrl)}</code></div>
      <a href="${escapeHtml(egernProfileImport)}"><strong>Egern 智能配置</strong><small>iPhone、iPad · 智能选择、分流和 DNS</small></a>
      <a href="${escapeHtml(egernImport)}"><strong>Egern 节点订阅</strong><small>只导入节点，保留客户端现有规则</small></a>
      <a href="${escapeHtml(singBoxUrl)}"><strong>sing-box JSON</strong><small>需要 sing-box 1.14+ 内核的客户端</small></a>
      <a href="${escapeHtml(mihomoUrl)}"><strong>下载 Mihomo YAML</strong><small>适用于 Clash Verge Rev、FlClash</small></a>
      <a href="${escapeHtml(egernUrl)}"><strong>下载 Egern YAML</strong><small>Egern 原生 proxies 节点集合</small></a>
    </div>
    <footer>同一个订阅身份支持 Mihomo、Loon、Egern 与 sing-box；重新生成订阅后，旧地址会统一失效。</footer>
  </main>
</body>
</html>`;
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    vary: "User-Agent, Accept",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow"
  });
  endRequestPayload(request, response, payload);
}

const subscriptionPathRegex = new RegExp(
  `^/sub/([A-Za-z0-9_-]{16,64})/([A-Za-z0-9_-]{32,128})(?:/(${subscriptionPathSuffixPattern}))?$`
);
const portalConfigRegex = new RegExp(
  `^/api/portal/config/(${subscriptionPortalAliasPattern})$`
);

function subscriptionFormatForRequest(request, url, pathFormat = "") {
  const explicit = String(url.searchParams.get("format") || pathFormat || "").toLowerCase();
  if (explicit) return resolveSubscriptionFormat(explicit) || "unsupported";
  const userAgent = String(request.headers["user-agent"] || "").toLowerCase();
  const accept = String(request.headers.accept || "").toLowerCase();
  const detected = subscriptionFormatForUserAgent(userAgent);
  if (detected) return detected;
  if (accept.includes("text/html") && /mozilla|safari|chrome|firefox|edge/.test(userAgent)) {
    return "landing";
  }
  return "mihomo";
}

async function sendStatic(response, webDir, pathname) {
  const relativePath = pathname === "/"
    ? "index.html"
    : ["/setup", "/setup/"].includes(pathname)
      ? "setup.html"
    : ["/portal", "/portal/"].includes(pathname)
      ? "portal.html"
      : decodeURIComponent(pathname).replace(/^\/+/, "");
  const filePath = resolve(webDir, relativePath);
  if (filePath !== webDir && !filePath.startsWith(`${webDir}${sep}`)) return false;
  try {
    const payload = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
      "content-length": payload.length,
      "cache-control": filePath.endsWith(".html") ? "no-cache" : "public, max-age=300",
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=()"
    });
    response.end(payload);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return false;
    throw error;
  }
}

function normalizedOrigin(value, fieldName) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw httpError("INVALID_SETUP_INPUT", `${fieldName}不是有效地址`, 422);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw httpError("INVALID_SETUP_INPUT", `${fieldName}必须是仅包含协议、域名或 IP 和端口的地址`, 422);
  }
  if (
    url.protocol !== "https:"
    && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  ) {
    throw httpError("HTTPS_REQUIRED", `${fieldName}在非本机环境必须使用 HTTPS`, 422);
  }
  return url.origin;
}

function normalizeSetupInput(body) {
  const accessMode = String(body.access?.mode || "");
  if (!["domain", "ip"].includes(accessMode)) {
    throw httpError("INVALID_SETUP_INPUT", "请选择域名或 IP 访问模式", 422);
  }
  const canonicalOrigin = normalizedOrigin(body.access?.canonicalOrigin, "主访问地址");
  const subscriptionOrigin = normalizedOrigin(
    body.access?.subscriptionOrigin || canonicalOrigin,
    "订阅服务地址"
  );
  const canonicalHost = new URL(canonicalOrigin).hostname.replace(/^\[|\]$/g, "");
  const subscriptionHost = new URL(subscriptionOrigin).hostname.replace(/^\[|\]$/g, "");
  if (accessMode === "domain" && isIP(canonicalHost)) {
    throw httpError("INVALID_SETUP_INPUT", "域名访问模式不能填写 IP 地址", 422);
  }
  if (accessMode === "domain" && isIP(subscriptionHost)) {
    throw httpError("INVALID_SETUP_INPUT", "订阅服务地址必须填写域名", 422);
  }
  if (accessMode === "ip" && !isIP(canonicalHost) && canonicalHost !== "localhost") {
    throw httpError("INVALID_SETUP_INPUT", "IP 访问模式必须填写 IP 地址", 422);
  }
  const allowedOrigins = [
    canonicalOrigin,
    ...(Array.isArray(body.access?.allowedOrigins) ? body.access.allowedOrigins : [])
  ].map((origin) => normalizedOrigin(origin, "允许的管理端地址"));
  const uniqueAllowedOrigins = [...new Set(allowedOrigins)];
  if (uniqueAllowedOrigins.length > 8) {
    throw httpError("INVALID_SETUP_INPUT", "最多允许配置 8 个管理端地址", 422);
  }

  const certificateMode = String(body.certificate?.mode || "");
  const certificateModes = accessMode === "domain"
    ? ["caddy-auto", "external"]
    : ["external", "ip-self-signed"];
  if (!certificateModes.includes(certificateMode)) {
    throw httpError("INVALID_SETUP_INPUT", "证书模式与当前访问方式不匹配", 422);
  }
  if (
    certificateMode === "caddy-auto"
    && (new URL(canonicalOrigin).port || new URL(subscriptionOrigin).port)
  ) {
    throw httpError(
      "CADDY_STANDARD_HTTPS_REQUIRED",
      "Caddy 自动 HTTPS 的控制台和订阅地址需要使用标准 443 端口",
      422
    );
  }
  const certificateEmail = certificateMode === "caddy-auto"
    ? normalizeCertificateEmail(body.certificate?.email, {
        errorCode: "INVALID_SETUP_INPUT"
      })
    : "";

  const username = String(body.admin?.username || "").trim();
  const password = String(body.admin?.password || "");
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    throw httpError("INVALID_SETUP_INPUT", "管理员用户名需为 3–64 位字母、数字或 ._-", 422);
  }
  const passwordClasses = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password)
  ].filter(Boolean).length;
  if (password.length < 12 || passwordClasses < 3) {
    throw httpError("INVALID_SETUP_INPUT", "管理员密码至少 12 位，并包含至少三类字符", 422);
  }

  const submittedRuntimeAddress = String(body.runtime?.address || "").trim();
  const runtime = {
    name: String(body.runtime?.name || "").trim(),
    address: accessMode === "domain"
      && isIP(submittedRuntimeAddress.replace(/^\[|\]$/g, ""))
      ? canonicalHost
      : submittedRuntimeAddress,
    region: String(body.runtime?.region || "").trim()
  };

  return {
    access: {
      mode: accessMode,
      canonicalOrigin,
      subscriptionOrigin,
      allowedOrigins: uniqueAllowedOrigins
    },
    certificate: {
      mode: certificateMode,
      ...(certificateMode === "caddy-auto" ? { email: certificateEmail } : {})
    },
    admin: { username, password },
    runtime
  };
}

function setupStateError(state) {
  if (state === "INITIALIZING") {
    return httpError("SETUP_IN_PROGRESS", "RayLink 正在初始化", 409);
  }
  if (state === "UNINITIALIZED") {
    return httpError(
      "SETUP_TOKEN_REQUIRED",
      "尚未生成初始化令牌，请在服务器运行令牌轮换命令",
      409
    );
  }
  return httpError("SETUP_ALREADY_COMPLETE", "RayLink 已完成初始化", 409);
}

function sessionCookie(name, secret, expiresAt, secure) {
  return [
    `${name}=${encodeURIComponent(secret)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    `Expires=${new Date(expiresAt).toUTCString()}`
  ].filter(Boolean).join("; ");
}

function clearedSessionCookie(name, secure) {
  return [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0"
  ].filter(Boolean).join("; ");
}

export async function createRayLinkApp(options) {
  const dbPath = options.dbPath || join(options.dataDir, "raylink.db");
  const publicOrigin = new URL(options.publicOrigin);
  const configuredSubscriptionOrigin = new URL(options.subscriptionOrigin || publicOrigin);
  const proxyHost = options.proxyHost || publicOrigin.hostname;
  const localHostDialAddress = String(options.localHostDialAddress || "").trim();
  const endpointResolver = options.endpointResolver || new EndpointResolver({
    cachePath: options.endpointCachePath || join(options.dataDir, "endpoint-cache.json"),
    dnsServers: options.endpointDnsServers,
    lookupTimeoutMs: options.endpointDnsTimeoutMs,
    probeTimeoutMs: options.endpointProbeTimeoutMs
  });
  const listenPort = options.listenPort || 8388;
  const store = new RayLinkStore({
    dbPath,
    adminUsername: options.adminUsername,
    adminPassword: options.adminPassword,
    initialHostAddress: proxyHost,
    initialListenPort: listenPort,
    seedDemoData: options.seedDemoData,
    nodeTaskRetryBaseMs: options.nodeTaskRetryBaseMs,
    setupRequired: options.setupRequired,
    setupTokenHash: options.setupTokenHash,
    setupTokenExpiresAt: options.setupTokenExpiresAt,
    subscriptionEncryptionKey: options.subscriptionEncryptionKey
      || options.adminPassword
  });
  const currentPublicOrigin = () => {
    const configured = store.setupStatus().access?.canonicalOrigin;
    return configured ? new URL(configured) : publicOrigin;
  };
  const currentSubscriptionOrigin = () => {
    const configured = store.setupStatus().access?.subscriptionOrigin;
    return configured ? new URL(configured) : configuredSubscriptionOrigin;
  };
  const resolveClientEndpointOverrides = async (hosts) => Object.fromEntries(
    (await Promise.all(hosts.map(async (host) => {
      const endpoint = host.endpointDomain || host.address;
      if (isIP(endpoint)) return null;
      const fallbackAddress = host.id === "local" ? localHostDialAddress : host.endpointDomain && isIP(host.address) ? host.address : "";
      const configuredFallback = isIP(fallbackAddress)
        ? { address: fallbackAddress, source: "configured-fallback" }
        : null;
      let resolved;
      try {
        resolved = await endpointResolver.resolve({
          hostname: endpoint,
          protocols: host.protocols,
          fallbackAddress
        });
      } catch (error) {
        console.warn(`[RayLink] Endpoint resolution failed for ${endpoint}: ${error.message}`);
        resolved = configuredFallback;
      }
      return isIP(resolved?.address) ? [endpoint, resolved.address] : null;
    }))).filter(Boolean)
  );
  const subscriptionUrl = (subscription) => new URL(
    `/sub/${subscription.publicId}/${subscription.secret}`,
    currentSubscriptionOrigin()
  ).toString();
  const subscriptionFormats = (subscription) => {
    return buildSubscriptionFormatUrls(subscriptionUrl(subscription));
  };
  const subscriptionDetails = (subscription) => {
    const universal = subscriptionUrl(subscription);
    const formats = subscriptionFormats(subscription);
    return {
      subscriptionUrl: universal,
      formats,
      imports: {
        clash: `clash://install-config?url=${encodeURIComponent(formats.mihomo)}&name=RayLink`,
        egern: `egern:/subscriptions/new?url=${encodeURIComponent(formats.egern)}`,
        egernProfile: `egern:/profiles/new?name=RayLink&url=${encodeURIComponent(formats.egernProfile)}`
      }
    };
  };
  const currentSubscription = (userId) => {
    const subscription = store.currentUserSubscription(userId);
    if (!subscription.configured) {
      throw httpError(
        "SUBSCRIPTION_NOT_CONFIGURED",
        "尚未生成订阅地址",
        404
      );
    }
    if (!subscription.recoverable) {
      if (subscription.reason === "decryption-failed") {
        console.warn(
          `[RayLink] Stored subscription credential for user ${userId} could not be decrypted`
        );
      }
      throw httpError(
        "SUBSCRIPTION_ADDRESS_UNAVAILABLE",
        subscription.reason === "decryption-failed"
          ? "现有订阅地址无法解密；请检查订阅加密密钥，或重新生成地址"
          : "现有订阅地址由旧版本生成，无法恢复；请重新生成一次，之后即可随时查看",
        409
      );
    }
    return subscriptionDetails(subscription);
  };
  const requestOriginIsAllowed = (request) => {
    const requestOrigin = request.headers.origin;
    if (!requestOrigin) return true;
    const allowedOrigins = store.setupStatus().access?.allowedOrigins
      || [currentPublicOrigin().origin];
    return allowedOrigins.includes(requestOrigin);
  };
  const webDir = resolve(options.webDir || defaultWebDir);
  const runtimeAdapter = options.runtimeAdapter || new LocalSingBoxAdapter({
    dataDir: options.dataDir,
    binaryPath: options.singBoxBinary || "sing-box",
    mode: options.runtimeMode || "dry-run",
    systemdUnit: options.systemdUnit || "sing-box.service",
    protocolProbeUrl: options.protocolProbeUrl
  });
  const tlsAssetPackager = options.tlsAssetPackager || new RemoteTlsAssetPackager({
    remoteDataDir: options.remoteNodeDataDir
  });
  const localTlsAssetStager = options.localTlsAssetStager || new LocalTlsAssetStager({
    dataDir: join(options.dataDir || "./data", "sing-box")
  });
  const runtimeManager = new RuntimeManager({
    store,
    adapter: runtimeAdapter,
    listenPort,
    tlsAssetPackager
  });
  const ruleSetCache = options.ruleSetCache || new ManagedRuleSetCache({
    dataDir: options.dataDir,
    fetchImpl: options.ruleSetFetch,
    ...(options.ruleSetManifestPath ? { manifestPath: options.ruleSetManifestPath } : {})
  });
  const backupManager = options.backupManager || new BackupManager({
    store,
    backupDir: options.backupDir || join(options.dataDir || "./data", "backups"),
    retentionCount: options.backupRetentionCount || 14
  });
  const alertDispatcher = options.alertDispatcher || new AlertWebhookDispatcher({
    webhookUrl: options.alertWebhookUrl,
    fetchImpl: options.alertFetch
  });
  const refreshRuleSets = () => ruleSetCache.prepare().catch((error) => {
    console.warn(`[RayLink] Managed rule-set refresh failed: ${error.message}`);
  });
  // Load the verified bundled/cache generation before serving the first export.
  await refreshRuleSets();
  const localTelemetryCollector = new LocalTelemetryCollector();
  const telemetryProvider = options.telemetryProvider
    || ((runtime) => localTelemetryCollector.collect(runtime));
  const telemetryIntervalMs = Math.max(10, Number(options.telemetryIntervalMs || 10_000));
  const entitlementReconcileIntervalMs = Math.max(
    1_000,
    Number(options.entitlementReconcileIntervalMs || 60_000)
  );
  let telemetryTimer = null;
  let telemetrySamplePromise = null;
  let entitlementReconcileTimer = null;
  let ruleSetRefreshTimer = null;
  let runtimeUpdateTimer = null;
  let usageMeteringTimer = null;
  let usageMeteringPromise = null;
  let protocolLatencyTimer = null;
  let protocolLatencyStartupTimer = null;
  let protocolLatencyPromise = null;
  let operationalMaintenanceTimer = null;
  let backupTimer = null;
  let backupStartupTimer = null;
  const backupOperations = new Set();
  const trackBackup = (operation) => {
    const promise = Promise.resolve().then(operation);
    backupOperations.add(promise);
    promise.finally(() => backupOperations.delete(promise)).catch(() => {});
    return promise;
  };
  let alertTimer = null;
  let localRuntimeOperation = null;
  const operationalMaintenanceIntervalMs = Math.max(
    60_000,
    Number(options.operationalMaintenanceIntervalMs || 60 * 60 * 1000)
  );
  const backupIntervalMs = Math.max(
    0,
    Number(options.backupIntervalMs ?? 24 * 60 * 60 * 1000)
  );
  const createScheduledBackup = () => trackBackup(() => backupManager.create().catch((error) => {
    console.warn(`[RayLink] Scheduled database backup failed: ${error.message}`);
  }));
  const createInitialBackup = () => trackBackup(async () => {
    try {
      if (!(await backupManager.list()).length) await backupManager.create();
    } catch (error) {
      console.warn(`[RayLink] Initial database backup failed: ${error.message}`);
    }
  });
  const alertIntervalMs = Math.max(
    0,
    Number(options.alertIntervalMs ?? 60_000)
  );
  const currentAlerts = async () => evaluateOperationalAlerts({
    hosts: store.listHosts(),
    deployments: store.listDeployments(),
    backups: await backupManager.list()
  });
  const routingRuleSetStatus = () => typeof ruleSetCache.status === "function"
    ? { ...ruleSetCache.status(), bundledVersion: getBundledRoutingVersion() } : null;
  let readinessPromise = null;
  const currentReadiness = () => {
    // Multiple operators/export clicks share one disk integrity scan.
    if (readinessPromise) return readinessPromise;
    readinessPromise = (async () => {
      const backups = await backupManager.list();
      const backupVerification = backups[0]
        ? await backupManager.verify(backups[0].filename).catch(() => ({ valid: false })) : null;
      const runtime = await runtimeManager.status();
      const hosts = store.listHosts();
      const deployments = store.listDeployments();
      return buildReadinessReport({
        hosts, deployments, backups, backupVerification, runtime,
        routingPolicy: store.routingPolicy(), ruleSets: routingRuleSetStatus(),
        alerts: evaluateOperationalAlerts({ hosts, deployments, backups })
      });
    })().finally(() => { readinessPromise = null; });
    return readinessPromise;
  };
  const dispatchOperationalAlerts = async () => {
    try {
      await alertDispatcher.dispatch(await currentAlerts());
    } catch (error) {
      console.warn(`[RayLink] Operational alert delivery failed: ${error.message}`);
    }
  };
  const runOperationalMaintenance = () => {
    try {
      return store.performOperationalMaintenance();
    } catch (error) {
      console.warn(`[RayLink] Operational maintenance failed: ${error.message}`);
      return null;
    }
  };
  const runLocalRuntimeOperation = async (operation, callback) => {
    if (localRuntimeOperation) {
      throw httpError(
        "RUNTIME_OPERATION_IN_PROGRESS",
        `Runtime 正在执行${localRuntimeOperation}，请完成后再试`,
        409
      );
    }
    localRuntimeOperation = operation;
    try {
      if (operation !== "系统更新" && ["queued", "running"].includes((await systemUpdateManager.status()).task?.status)) {
        throw httpError("SYSTEM_UPDATE_BUSY", "系统更新仍在执行，请等待服务恢复后再修改 Runtime", 409);
      }
      return await callback();
    } finally {
      localRuntimeOperation = null;
    }
  };
  const sampleLocalTelemetry = () => {
    if (telemetrySamplePromise) return telemetrySamplePromise;
    telemetrySamplePromise = (async () => {
      try {
        const runtime = await runtimeManager.status();
        store.recordHostTelemetry("local", { ...await telemetryProvider(runtime), bbr: await bbrManager.inspect() });
      } catch (error) {
        console.warn(`[RayLink] Local telemetry sample failed: ${error.message}`);
      }
    })().finally(() => {
      telemetrySamplePromise = null;
    });
    return telemetrySamplePromise;
  };
  const installer = options.installer || new SingBoxInstaller({
    binaryPath: options.singBoxBinary || "sing-box",
    dataDir: options.dataDir,
    activeConfigPath: runtimeAdapter.activePath,
    runtimeMode: options.runtimeMode || "dry-run",
    systemdUnit: options.systemdUnit || "sing-box.service",
    preferMeteredRuntime: options.preferMeteredRuntime,
    meteredRuntimeBuilder: options.meteredRuntimeBuilder,
    fetchImpl: options.runtimeReleaseFetch
  });
  const requestOriginFor = (request) => {
    const forwardedProtocol = options.trustProxy
      ? String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim()
      : "";
    const requestProtocol = ["http", "https"].includes(forwardedProtocol)
      ? forwardedProtocol
      : request.socket.encrypted
        ? "https"
        : "http";
    return request.headers.host ? `${requestProtocol}://${request.headers.host}` : "";
  };
  const setupAccessManager = options.setupAccessManager || new CaddySetupAccessManager({
    caddyfilePath: options.caddyfilePath || "/etc/caddy/Caddyfile",
    environmentFilePath: options.environmentFilePath || "/etc/raylink/raylink.env",
    initialOrigin: publicOrigin.origin,
    certificatePath: options.controlPlaneCertificatePath
      || "/etc/caddy/raylink/control-plane.crt",
    privateKeyPath: options.controlPlanePrivateKeyPath
      || "/etc/caddy/raylink/control-plane.key",
    caddyBinary: options.caddyBinary || "caddy"
  });
  const protocolActivationManager = options.protocolActivationManager
    || new ProtocolActivationManager({
      store,
      runtimeManager,
      installer,
      ...(options.portManager ? { portManager: options.portManager } : {}),
      firewallManager: options.firewallManager || new UfwFirewallManager({
        enabled: options.runtimeMode === "systemd"
      }),
      ...(options.publicProbe ? { publicProbe: options.publicProbe } : {}),
      protocolProbe: options.protocolProbe
        || (typeof runtimeAdapter.probeProtocol === "function"
          ? (input) => runtimeAdapter.probeProtocol(input)
          : null),
      certificateEmail: () => store.certificateSettings().email,
      certificateProvider: async (domain) => {
        if (store.certificateSettings().mode !== "caddy-auto") return null;
        return setupAccessManager.ensureNodeCertificate(domain);
      },
      certificateStager: (input) => localTlsAssetStager.stage(input),
      runtimeMode: options.runtimeMode || "dry-run"
    });
  const protocolLatencyIntervalMs = Math.max(
    0,
    Number(options.protocolLatencyIntervalMs ?? (
      (options.runtimeMode || "dry-run") === "systemd" ? 5 * 60 * 1000 : 0
    ))
  );
  const sampleProtocolLatencies = () => {
    if (protocolLatencyPromise) return protocolLatencyPromise;
    if (typeof protocolActivationManager.measureHost !== "function") {
      return Promise.resolve(null);
    }
    protocolLatencyPromise = (async () => {
      const hosts = store.listHosts();
      for (const host of hosts) {
        try {
          await protocolActivationManager.measureHost({ hostId: host.id });
        } catch (error) {
          if (error.code !== "PROTOCOL_LATENCY_IN_PROGRESS") {
            console.warn(
              `[RayLink] ${host.name} protocol latency sample failed: ${error.message}`
            );
          }
        }
      }
    })().finally(() => {
      protocolLatencyPromise = null;
    });
    return protocolLatencyPromise;
  };
  const bbrManager = options.bbrManager || new BbrManager({
    mode: options.runtimeMode || "dry-run",
    configPath: options.bbrConfigPath
  });
  const runtimeSetupManager = options.runtimeSetupManager || new RuntimeSetupManager({
    store, installer, runtimeManager, runtimeAdapter, bbrManager,
    runtimeMode: options.runtimeMode || "dry-run",
    statePath: join(options.dataDir || "./data", "runtime-setup.json"),
    ...(options.runtimePlatform ? { platform: options.runtimePlatform } : {}),
    ...(options.portManager ? { portManager: options.portManager } : {}),
    ...(options.firewallManager ? { firewallManager: options.firewallManager } : {})
  });
  const systemUpdateManager = options.systemUpdateManager || new SystemUpdateManager({
    dataDir: options.dataDir || "./data", runtimeMode: options.runtimeMode || "dry-run",
    ...(options.systemReleaseFetch ? { fetchImpl: options.systemReleaseFetch } : {})
  });
  const preserveAutomaticRecoveryOrigin = (input) => {
    if (
      input.certificate.mode === "caddy-auto"
      && !input.access.allowedOrigins.includes(publicOrigin.origin)
    ) {
      input.access.allowedOrigins.push(publicOrigin.origin);
    }
  };
  const preflightSetup = async (request, input) => {
    const requestOrigin = requestOriginFor(request);
    const automaticDomain = input.certificate.mode === "caddy-auto";
    if (
      automaticDomain
        ? requestOrigin !== publicOrigin.origin
          && !input.access.allowedOrigins.includes(requestOrigin)
        : requestOrigin !== input.access.canonicalOrigin
    ) {
      throw httpError(
        "SETUP_ORIGIN_NOT_ACTIVE",
        automaticDomain
          ? "请通过当前 IP 初始化入口配置域名"
          : "请先通过主访问地址打开初始化链接，确认 DNS 与 HTTPS 可用后再完成初始化",
        422
      );
    }
    const accessChecks = automaticDomain
      ? await setupAccessManager.preflight(input)
      : {};
    const bbr = await bbrManager.inspect();
    const installation = await installer.status();
    return {
      checks: {
        setupToken: "passed",
        accessOrigin: automaticDomain ? "configuration-ready" : "passed",
        https: automaticDomain
          ? "automatic"
          : new URL(input.access.canonicalOrigin).protocol === "https:"
            ? "passed"
            : "development",
        runtime: options.runtimeMode === "systemd" ? installation.installed ? "installed" : "automatic-install" : "development",
        bbr: bbr.status,
        ...accessChecks
      }
    };
  };
  const refreshLocalRuntimeCapabilities = async () => {
    const installation = await installer.status();
    store.updateLocalRuntimeCapabilities(installation);
    return installation;
  };
  const usageCollector = options.usageCollector || new V2RayStatsCollector({
    endpoint: options.v2rayStatsEndpoint || "http://127.0.0.1:10085",
    runtimeInstanceProvider: () => systemdRuntimeInstanceId(
      options.systemdUnit || "sing-box.service"
    )
  });
  const usageMeteringIntervalMs = Math.max(
    1_000,
    Number(options.usageMeteringIntervalMs || 30_000)
  );
  const sampleLocalUsage = () => {
    if (usageMeteringPromise) return usageMeteringPromise;
    if (!store.getHost("local")?.usageMetering.supported) return Promise.resolve(null);
    usageMeteringPromise = (async () => {
      try {
        const result = store.recordUsageSnapshot("local", await usageCollector.collect());
        if (result.quotaExceededUserIds.length) {
          await reconcileUserEntitlements(null, {
            forceCritical: true,
            reason: "usage-quota-enforcement"
          });
        }
        return result;
      } catch (error) {
        store.recordUsageMeteringError("local", error.message);
        console.warn(`[RayLink] Local user usage sample failed: ${error.message}`);
        return null;
      }
    })().finally(() => {
      usageMeteringPromise = null;
    });
    return usageMeteringPromise;
  };
  const runtimeUpdateCheckIntervalMs = Math.max(
    0,
    Number(options.runtimeUpdateCheckIntervalMs ?? 6 * 60 * 60 * 1000)
  );
  const refreshRuntimeUpdate = () => {
    if (typeof installer.checkForUpdates !== "function") return Promise.resolve(null);
    return installer.checkForUpdates().catch((error) => {
      console.warn(`[RayLink] sing-box update check failed: ${error.message}`);
      return null;
    });
  };
  const buildClientConfigForUser = async (userId) => {
    const credential = store.clientCredential(userId);
    if (!credential) throw httpError("USER_NOT_FOUND", "用户不存在", 404);
    const expiresAt = new Date(`${credential.expiresAt}T23:59:59.999Z`);
    const runtime = await runtimeManager.status();
    const allowStagedClientConfigs = options.allowStagedClientConfigs
      ?? process.env.NODE_ENV !== "production";
    const eligibleHosts = store.listClientHosts().filter((host) => {
      const metricsAgeMs = host.telemetry.updatedAt
        ? Date.now() - new Date(host.telemetry.updatedAt).getTime()
        : Number.POSITIVE_INFINITY;
      const connected = host.id === "local"
        ? runtime.state === "running" || allowStagedClientConfigs
        : host.status === "online"
          && host.telemetry.serviceStatus === "running"
          && metricsAgeMs <= 30_000;
      const regionAllowed = credential.nodeScope.includes("all")
        || credential.nodeScope.includes(host.region);
      return connected && regionAllowed;
    }).map((host) => ({
      ...host,
      protocols: host.appliedProtocols
    }));
    if (
      !["active", "warning"].includes(credential.state)
      || credential.portalStatus !== "active"
      || credential.usedGb >= credential.quotaGb
      || expiresAt < new Date()
      || !eligibleHosts.length
    ) {
      throw httpError("ENTITLEMENT_INACTIVE", "账号当前不可使用", 403);
    }
    const endpointOverrides = await resolveClientEndpointOverrides(eligibleHosts);
    const singBoxConfig = buildUserClientConfig({
      credential,
      hosts: eligibleHosts,
      probeUrl: options.protocolProbeUrl,
      routePolicy: store.routingPolicy(),
      ruleSetBaseUrl: ruleSetCache.available()
        ? new URL("/rule-sets/", currentSubscriptionOrigin()).toString()
        : null
    });
    return { singBoxConfig, endpointOverrides };
  };
  const nodeDomains = new NodeDomains({ store, fetchImpl: options.nodeDomainFetch, lookup: options.nodeDomainLookup,
    pollMs: options.nodeDomainPollMs, waitMs: options.nodeDomainWaitMs });
  const nodeProvisioning = new NodeProvisioning({
    store, sshBootstrap: options.sshBootstrap, publicOrigin: () => currentPublicOrigin().origin,
    nodeDomains,
    pollMs: options.provisioningPollMs, waitMs: options.provisioningWaitMs,
    acceptedNodeVersions: SUPPORTED_NODE_VERSIONS,
    trustedControlPlaneCa: async () => store.certificateSettings().mode === "ip-self-signed"
      ? readFile(options.controlPlaneCertificatePath || "/etc/caddy/raylink/control-plane.crt", "utf8") : null,
    buildClientConfig: buildClientConfigForUser,
    measure: (input) => protocolActivationManager.measureHost(input),
    activate: ({ preferredPort, template, ...input }) => runLocalRuntimeOperation("节点自动接入", async () => {
      const profile = store.listHostProtocolConfigs(input.hostId).find((entry) => entry.type === input.type);
      if (!profile.enabled && !store.getHost(input.hostId).protocolActivations.some((entry) => entry.type === input.type)) {
        store.updateHostProtocolConfig(input.hostId, input.type, { port: preferredPort,
          ...(template ? { transport: template.transport, options: template.options } : {}) });
      }
      return protocolActivationManager.enable(input);
    })
  });
  const reconcileUserEntitlements = async (publisherAdminId, reconcileOptions = {}) => {
    try {
      const result = await runLocalRuntimeOperation(
        "配置同步",
        () => runtimeManager.reconcile(publisherAdminId, reconcileOptions)
      );
      return {
        status: result.changed ? "published" : "current",
        reason: result.reason || null
      };
    } catch (error) {
      console.warn(`[RayLink] User entitlement saved; runtime publication pending: ${error.message}`);
      return {
        status: "pending",
        message: "用户变更已保存，运行配置发布失败，系统将自动重试"
      };
    }
  };
  const authAttempts = new Map();
  const nodeHeartbeatWrites = new Map();
  const nodeHeartbeatMinIntervalMs = Math.max(0, Number(options.nodeHeartbeatMinIntervalMs ?? 5_000));
  const authWindowMs = 10 * 60 * 1000;
  const authAttemptLimit = 8;
  const clientAddress = (request) => {
    if (options.trustProxy) {
      const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
      if (forwarded) return forwarded;
    }
    return request.socket.remoteAddress || "unknown";
  };
  const authKey = (request, kind) => [clientAddress(request), kind].join("|");
  const authAllowed = (key) => {
    const now = Date.now();
    if (authAttempts.size > 10_000) {
      for (const [candidateKey, candidate] of authAttempts) {
        if (candidate.resetAt <= now || authAttempts.size > 9_000) authAttempts.delete(candidateKey);
        if (authAttempts.size <= 9_000) break;
      }
    }
    const entry = authAttempts.get(key);
    if (!entry || entry.resetAt <= now) {
      authAttempts.set(key, { count: 0, resetAt: now + authWindowMs });
      return true;
    }
    return entry.count < authAttemptLimit;
  };
  const recordAuthFailure = (key) => {
    const entry = authAttempts.get(key);
    if (entry) entry.count += 1;
  };

  // Browser API and MCP share the same authorization and business operations.
  const handleAdminRequest = async (request, response, admin) => {
    const url = new URL(request.url, currentPublicOrigin());
    const requiredPermission = adminPermissionForRequest(request.method, url.pathname);
    const permissions = rolePermissions.get(admin.role || "owner") || new Set();
    if (!permissions.has(requiredPermission)) {
      sendJson(response, 403, {
        error: {
          code: "FORBIDDEN",
          message: "当前管理员角色无权执行此操作"
        }
      });
      return;
    }

    if (!request.mcp && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const { resourceType, resourceId } = auditResource(url.pathname);
      response.once("finish", () => {
        if (response.statusCode >= 400) return;
        try {
          store.recordAuditEvent({
            adminId: admin.id,
            actorUsername: admin.username,
            actorRole: admin.role || "owner",
            action: `${request.method} ${url.pathname}`,
            resourceType,
            resourceId,
            metadata: { statusCode: response.statusCode }
          });
        } catch (error) {
          console.warn(`[RayLink] Audit event could not be recorded: ${error.message}`);
        }
      });
    }

    if ((request.method === "POST" && url.pathname === "/api/account/password")
      || (request.method === "PATCH" && url.pathname === "/api/account/profile")) {
      if (request.mcp) {
        sendJson(response, 403, { error: { code: "FORBIDDEN", message: "请通过浏览器登录后修改个人账号" } });
        return;
      }
      const attemptKey = authKey(request, `account:${admin.id}`);
      if (!authAllowed(attemptKey)) {
        sendJson(response, 429, { error: { code: "RATE_LIMITED", message: "密码验证次数过多，请稍后重试" } });
        return;
      }
      try {
        const result = await store.changeAdminAccount(admin.id, await readJson(request), {
          changePassword: url.pathname === "/api/account/password"
        });
        authAttempts.delete(attemptKey);
        sendJson(response, 200, result, { "set-cookie": clearedSessionCookie(SESSION_COOKIE, currentPublicOrigin().protocol === "https:") });
      } catch (error) {
        if (error.code === "CURRENT_PASSWORD_INVALID") recordAuthFailure(attemptKey);
        throw error;
      }
      return;
    }

    if (url.pathname === "/api/hosts/provision") {
      if (request.method === "GET") {
        sendJson(response, 200, { jobs: nodeProvisioning.list() });
        return;
      }
      if (request.method === "POST") {
        sendJson(response, 202, { job: nodeProvisioning.start(await readJson(request), admin.id) });
        return;
      }
    }
    const provisioningMatch = url.pathname.match(/^\/api\/hosts\/provision\/([^/]+)(\/retry)?$/);
    if (provisioningMatch && request.method === (provisioningMatch[2] ? "POST" : "GET")) {
      const id = decodeURIComponent(provisioningMatch[1]);
      sendJson(response, provisioningMatch[2] ? 202 : 200, { job: provisioningMatch[2]
        ? nodeProvisioning.retry(id, await readJson(request), admin.id)
        : nodeProvisioning.get(id) });
      return;
    }

    if (url.pathname === "/api/settings/node-domains" && ["GET", "PATCH"].includes(request.method)) {
      sendJson(response, 200, { nodeDomains: request.method === "GET" ? nodeDomains.settings() : nodeDomains.updateSettings(await readJson(request)) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/mcp/tokens") {
      sendJson(response, 200, {
        tokens: mcpCredentials.list(), scopes: MCP_SCOPES,
        endpoint: new URL("/mcp", currentPublicOrigin()).toString()
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/mcp/tokens") {
      const input = await readJson(request);
      sendJson(response, 201, mcpCredentials.create({ ...input, adminId: admin.id }));
      return;
    }
    const mcpTokenMatch = url.pathname.match(/^\/api\/mcp\/tokens\/([^/]+)$/);
    if (request.method === "DELETE" && mcpTokenMatch) {
      sendJson(response, 200, mcpCredentials.revoke(decodeURIComponent(mcpTokenMatch[1])));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/admins") {
      sendJson(response, 200, { admins: store.listAdmins() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/admins") {
      sendJson(response, 201, store.createAdmin(await readJson(request)));
      return;
    }

    const adminMatch = url.pathname.match(/^\/api\/admins\/([^/]+)$/);
    if (request.method === "PATCH" && adminMatch) {
      const targetId = decodeURIComponent(adminMatch[1]);
      const input = await readJson(request);
      if (targetId === admin.id && (input.password !== undefined || input.username !== undefined)) {
        sendJson(response, 403, { error: {
          code: "ACCOUNT_SELF_SERVICE_REQUIRED",
          message: "修改本人登录名或密码需要使用个人账号设置并验证当前密码"
        } });
        return;
      }
      sendJson(response, 200, store.updateAdmin(targetId, input));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/audit") {
      sendJson(response, 200, {
        events: store.listAuditEvents(url.searchParams.get("limit"))
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/backups") {
      sendJson(response, 200, { backups: await backupManager.list() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/alerts") {
      sendJson(response, 200, {
        alerts: await currentAlerts(),
        delivery: alertDispatcher.status()
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/operations/readiness") {
      sendJson(response, 200, await currentReadiness());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/backups") {
      sendJson(response, 201, await backupManager.create());
      return;
    }

    const backupVerifyMatch = url.pathname.match(
      /^\/api\/backups\/([^/]+)\/verify$/
    );
    if (request.method === "POST" && backupVerifyMatch) {
      sendJson(
        response,
        200,
        await backupManager.verify(decodeURIComponent(backupVerifyMatch[1]))
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      const installation = await refreshLocalRuntimeCapabilities();
      const runtime = await runtimeManager.status();
      const bbr = { ...await bbrManager.inspect(), checkedAt: new Date().toISOString() };
      const runtimeSetup = await runtimeSetupManager.status();
      if (runtimeSetup.ready && runtime.state !== "running") { runtimeSetup.ready = false; runtimeSetup.message = "曾完成安装，当前服务未运行，请重新配置或检查服务"; }
      const bootstrap = store.bootstrap(admin);
      const deployments = store.listDeployments();
      const backups = await backupManager.list();
      const hosts = bootstrap.hosts.map((host) => {
        const capabilities = host.id === "local"
          ? installation
          : {
              installed: Boolean(host.runtimeVersion),
              version: host.runtimeVersion,
              platform: host.platform || "linux",
              architecture: host.architecture,
              tags: host.buildTags
            };
        return {
          ...host,
          nodeUpgrade: { ...host.nodeUpgrade, availableVersion: CURRENT_NODE_VERSION, supported: host.kind === "remote" && supportsNodeMaintenance(host.agentVersion),
            blockedReason: !supportsNodeMaintenance(host.agentVersion) ? "旧 Node 需先执行一次升级命令以启用自动更新" : null },
          protocolCatalog: protocolCatalog.map(
            (protocol) => ({
              ...protocolAvailability(protocol, capabilities),
              activationPolicy: protocolActivationPolicy(protocol.type)
            })
          )
        };
      });
      const alerts = evaluateOperationalAlerts({ hosts, deployments, backups });
      const routingRuleSets = routingRuleSetStatus();
      sendJson(response, 200, {
        ...bootstrap,
        hosts,
        admins: admin.role === "owner" ? store.listAdmins() : [],
        auditEvents: ["owner", "operator", "auditor"].includes(admin.role)
          ? store.listAuditEvents(30)
          : [],
        access: store.setupStatus().access,
        certificate: store.certificateSettings(),
        nodeDomains: nodeDomains.settings(),
        provisioning: nodeProvisioning.availability(),
        routingPolicy: store.routingPolicy(),
        routingRuleSets,
        telemetry: store.telemetryOverview(),
        runtime,
        bbr, runtimeSetup, systemUpdate: await systemUpdateManager.status(),
        runtimePreview: runtimeManager.preview(),
        deployments,
        backups,
        alerts,
        alertDelivery: alertDispatcher.status(),
        installation,
        runtimeUpdate: typeof installer.releaseStatus === "function"
          ? installer.releaseStatus()
          : null,
        protocolCatalog: protocolCatalog.map((protocol) => ({
          ...protocolAvailability(protocol, installation),
          activationPolicy: protocolActivationPolicy(protocol.type)
        }))
      });
      return;
    }

    if (
      request.method === "PATCH"
      && url.pathname === "/api/settings/routing"
    ) {
      sendJson(
        response,
        200,
        store.updateRoutingPolicy(await readJson(request))
      );
      return;
    }

    if (
      request.method === "POST"
      && url.pathname === "/api/routing/diagnose"
    ) {
      const body = await readJson(request);
      sendJson(
        response,
        200,
        await diagnoseRoutingDomain({
          domain: body.domain,
          policy: store.routingPolicy(),
          matchRuleSet: ruleSetCache.available()
            && typeof ruleSetCache.matches === "function"
            ? (filename, value) => ruleSetCache.matches(
                filename,
                value,
                options.singBoxBinary || "sing-box"
              )
            : null
        })
      );
      return;
    }

    if (
      request.method === "PATCH"
      && url.pathname === "/api/settings/certificate"
    ) {
      sendJson(
        response,
        200,
        store.updateCertificateSettings(await readJson(request))
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/system/update") {
      sendJson(response, 200, await systemUpdateManager.check());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/system/upgrade") {
      sendJson(response, 202, await runLocalRuntimeOperation("系统更新", () => systemUpdateManager.upgrade()));
      return;
    }
    const bbrMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/bbr$/);
    if (request.method === "POST" && bbrMatch) {
      const host = store.getHost(decodeURIComponent(bbrMatch[1]));
      if (!host) throw httpError("HOST_NOT_FOUND", "主机不存在", 404);
      if (host.kind === "local") {
        if (options.runtimeMode !== "systemd") throw httpError("BBR_UNSUPPORTED", "本机测试模式不能配置 Linux BBR", 422);
        const bbr = await runLocalRuntimeOperation("BBR 配置", () => bbrManager.configure());
        store.recordHostTelemetry(host.id, { ...host.telemetry, bbr });
        sendJson(response, 200, { bbr: store.getHost(host.id).telemetry.bbr });
      } else {
        if (!host.enrolledAt) throw httpError("NODE_NOT_ENROLLED", "节点尚未接入", 409);
        if (!supportsNodeMaintenance(host.agentVersion)) throw httpError("NODE_UPGRADE_REQUIRED", "请先升级 Node 至 0.9.0，以支持 BBR 远程配置", 409);
        if (store.hostTaskStatus(host.id, "configure-bbr").pending) throw httpError("BBR_TASK_PENDING", "BBR 配置任务正在等待节点执行", 409);
        const taskId = store.queueNodeTask(host.id, "configure-bbr", {}, { maxAttempts: 1 });
        sendJson(response, 202, { taskId, status: "queued" });
      }
      return;
    }
    const nodeUpgradeMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/node-upgrade$/);
    if (request.method === "POST" && nodeUpgradeMatch) {
      const host = store.getHost(decodeURIComponent(nodeUpgradeMatch[1]));
      if (!host || host.kind !== "remote") throw httpError("REMOTE_HOST_NOT_FOUND", "远程主机不存在", 404);
      if (!host.enrolledAt) throw httpError("NODE_NOT_ENROLLED", "节点尚未接入", 409);
      if (!supportsNodeMaintenance(host.agentVersion)) throw httpError("NODE_UPGRADE_REQUIRED", "旧 Node 不支持自更新，请先执行一次升级命令", 409);
      if (host.nodeUpgrade.pending) throw httpError("NODE_UPDATE_BUSY", "Node 更新正在执行", 409);
      if (!versionIsOlder(host.agentVersion, CURRENT_NODE_VERSION)) throw httpError("NODE_ALREADY_CURRENT", "Node 已是当前控制面提供的最新版本", 409);
      const scriptSha256 = createHash("sha256").update(await readFile(join(webDir, "node/upgrade.sh"))).digest("hex");
      const taskId = store.queueNodeTask(host.id, "upgrade-node", { targetVersion: CURRENT_NODE_VERSION, scriptSha256 }, { maxAttempts: 1 });
      sendJson(response, 202, { taskId, status: "queued", targetVersion: CURRENT_NODE_VERSION });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/runtime/status") {
      sendJson(response, 200, await runtimeManager.status());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/runtime/installation") {
      sendJson(response, 200, await installer.status());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/runtime/install") {
      sendJson(
        response,
        200,
        await runLocalRuntimeOperation("自动安装与配置", async () => ({ ...await runtimeSetupManager.configure({ publisherAdminId: admin.id }), runtimeSetup: await runtimeSetupManager.status() }))
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/runtime/update") {
      if (typeof installer.checkForUpdates !== "function") {
        throw httpError("UPDATE_CHECK_UNAVAILABLE", "当前 Runtime 不支持在线版本检查", 501);
      }
      sendJson(response, 200, await installer.checkForUpdates());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/runtime/upgrade") {
      if (
        typeof installer.checkForUpdates !== "function"
        || typeof installer.upgrade !== "function"
      ) {
        throw httpError("RUNTIME_UPGRADE_UNAVAILABLE", "当前 Runtime 不支持在线升级", 501);
      }
      const update = await installer.checkForUpdates();
      if (!update.updateAvailable) {
        throw httpError(
          update.blockedReason ? "RUNTIME_UPGRADE_INCOMPATIBLE" : "RUNTIME_ALREADY_CURRENT",
          update.blockedReason || "当前 sing-box 已是可用的最新稳定版本",
          409
        );
      }
      const upgraded = await runLocalRuntimeOperation(
        "在线升级",
        () => installer.upgrade(update.latestVersion)
      );
      sendJson(response, 200, upgraded);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/runtime/reality-keypair") {
      sendJson(response, 201, await installer.generateRealityKeypair());
      return;
    }

    const protocolMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/protocols\/([^/]+)$/);
    if (request.method === "PATCH" && protocolMatch) {
      const hostId = decodeURIComponent(protocolMatch[1]);
      const protocolType = decodeURIComponent(protocolMatch[2]);
      const input = await readJson(request);
      const host = store.getHost(hostId);
      if (!host) {
        sendJson(response, 404, { error: { code: "HOST_NOT_FOUND", message: "主机不存在" } });
        return;
      }
      const candidate = store.prepareHostProtocolConfig(hostId, protocolType, input);
      if (candidate.enabled) {
        if (host.kind === "remote" && !host.runtimeVersion) {
          throw httpError(
            "HOST_CAPABILITIES_UNKNOWN",
            "远程主机尚未上报 sing-box 能力，请先完成 RayLink Node 接入",
            409
          );
        }
        const installation = host.id === "local"
          ? await installer.status()
          : host.runtimeVersion
            ? {
                installed: true,
                version: host.runtimeVersion,
                platform: host.platform,
                architecture: host.architecture,
                tags: host.buildTags
              }
            : null;
        const catalog = protocolCatalog.find((entry) => entry.type === protocolType);
        const availability = installation
          ? protocolAvailability(catalog, installation)
          : null;
        if (availability && !availability.available) {
          sendJson(response, 422, {
            error: {
              code: "PROTOCOL_UNAVAILABLE",
              message: !availability.versionSupported
                ? `RayLink 当前协议 schema 支持 sing-box 1.13.x / 1.14.x，检测到 ${installation.version || "未知版本"}`
                : availability.platformSupported
                  ? `当前 sing-box 构建缺少 ${availability.missingTags.join(", ") || "所需能力"}`
                  : `当前平台不支持 ${catalog.name}`
            }
          });
          return;
        }
        if (availability && candidate.tls.mode === "reality" && !availability.realityAvailable) {
          sendJson(response, 422, {
            error: { code: "REALITY_UNAVAILABLE", message: "当前 sing-box 构建缺少 with_utls" }
          });
          return;
        }
        if (availability && candidate.transport.type === "quic" && !availability.quicTransportAvailable) {
          sendJson(response, 422, {
            error: { code: "QUIC_UNAVAILABLE", message: "当前 sing-box 构建缺少 with_quic" }
          });
          return;
        }
      }
      sendJson(response, 200, store.updateHostProtocolConfig(hostId, protocolType, input));
      return;
    }

    const protocolActivationMatch = url.pathname.match(
      /^\/api\/hosts\/([^/]+)\/protocols\/([^/]+)\/activate$/
    );
    if (request.method === "POST" && protocolActivationMatch) {
      const result = await runLocalRuntimeOperation(
        "协议一键启用",
        () => protocolActivationManager.enable({
          hostId: decodeURIComponent(protocolActivationMatch[1]),
          type: decodeURIComponent(protocolActivationMatch[2]),
          adminId: admin.id
        })
      );
      sendJson(response, result.activation?.asynchronous ? 202 : 200, result);
      return;
    }

    const protocolLatencyMatch = url.pathname.match(
      /^\/api\/hosts\/([^/]+)\/protocols\/latency$/
    );
    if (request.method === "POST" && protocolLatencyMatch) {
      sendJson(
        response,
        200,
        await protocolActivationManager.measureHost({
          hostId: decodeURIComponent(protocolLatencyMatch[1])
        })
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/deployments") {
      sendJson(response, 200, { deployments: store.listDeployments() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/deployments/preview") {
      sendJson(response, 200, runtimeManager.preview());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/deployments") {
      await refreshLocalRuntimeCapabilities();
      sendJson(
        response,
        201,
        await runLocalRuntimeOperation("配置发布", () => runtimeManager.publish(admin.id))
      );
      return;
    }

    const rollbackMatch = url.pathname.match(/^\/api\/deployments\/([^/]+)\/rollback$/);
    if (request.method === "POST" && rollbackMatch) {
      sendJson(
        response,
        201,
        await runLocalRuntimeOperation(
          "配置回滚",
          () => runtimeManager.rollback(decodeURIComponent(rollbackMatch[1]), admin.id)
        )
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/users") {
      const user = store.createUser(await readJson(request));
      const runtimeSync = await reconcileUserEntitlements(admin.id);
      sendJson(response, runtimeSync.status === "pending" ? 202 : 201, {
        ...user,
        runtimeSync
      });
      return;
    }

    const currentUserSubscriptionMatch = url.pathname.match(
      /^\/api\/users\/([^/]+)\/subscription$/
    );
    if (request.method === "GET" && currentUserSubscriptionMatch) {
      sendJson(
        response,
        200,
        currentSubscription(decodeURIComponent(currentUserSubscriptionMatch[1]))
      );
      return;
    }
    const rotateUserSubscriptionMatch = url.pathname.match(
      /^\/api\/users\/([^/]+)\/subscription\/rotate$/
    );
    if (request.method === "POST" && rotateUserSubscriptionMatch) {
      const subscription = store.rotateUserSubscription(
        decodeURIComponent(rotateUserSubscriptionMatch[1])
      );
      sendJson(response, 201, subscriptionDetails(subscription));
      return;
    }

    const resetUserPasswordMatch = url.pathname.match(
      /^\/api\/users\/([^/]+)\/password\/reset$/
    );
    if (request.method === "POST" && resetUserPasswordMatch) {
      const body = await readJson(request);
      sendJson(
        response,
        200,
        store.resetUserPassword(
          decodeURIComponent(resetUserPasswordMatch[1]),
          body.password
        )
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/hosts") {
      sendJson(response, 201, store.createRemoteHost(await readJson(request)));
      return;
    }

    const enrollmentTokenMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/enrollment-token$/);
    if (request.method === "POST" && enrollmentTokenMatch) {
      sendJson(
        response,
        201,
        store.rotateNodeEnrollmentToken(decodeURIComponent(enrollmentTokenMatch[1]))
      );
      return;
    }

    const runtimeUpgradeMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/runtime-upgrade$/);
    if (request.method === "POST" && runtimeUpgradeMatch) {
      const hostId = decodeURIComponent(runtimeUpgradeMatch[1]);
      const host = store.getHost(hostId);
      if (!host || host.kind !== "remote") {
        throw httpError("REMOTE_HOST_NOT_FOUND", "远程主机不存在", 404);
      }
      if (!host.enrolledAt) {
        throw httpError("NODE_NOT_ENROLLED", "远程主机尚未完成 RayLink Node 接入", 409);
      }
      if (![RUNTIME_UPGRADE_NODE_VERSION, CURRENT_NODE_VERSION].includes(host.agentVersion)) {
        throw httpError(
          "NODE_UPGRADE_REQUIRED",
          `请先通过 /node/upgrade.sh 将 RayLink Node 升级到 ${RUNTIME_UPGRADE_NODE_VERSION}，再升级 Runtime`,
          409
        );
      }
      if (typeof installer.checkForUpdates !== "function") {
        throw httpError("UPDATE_CHECK_UNAVAILABLE", "当前 Runtime 不支持在线版本检查", 501);
      }
      const update = await installer.checkForUpdates();
      if (!update.compatible || !update.latestVersion) {
        throw httpError(
          "RUNTIME_UPGRADE_INCOMPATIBLE",
          update.blockedReason || "最新稳定版与当前 RayLink 不兼容",
          409
        );
      }
      const targetVersion = update.approvedVersion || APPROVED_METERED_RUNTIME_VERSION;
      const needsMeteredRebuild = host.runtimeVersion === targetVersion
        && !host.usageMetering.supported;
      if (!versionIsOlder(host.runtimeVersion, targetVersion) && !needsMeteredRebuild) {
        throw httpError("RUNTIME_ALREADY_CURRENT", "该主机已是最新版本", 409);
      }
      const taskId = store.queueNodeTask(host.id, "upgrade-runtime", {
        targetVersion,
        requestedAt: new Date().toISOString()
      }, { maxAttempts: 1 });
      sendJson(response, 202, {
        taskId,
        status: "queued",
        targetVersion
      });
      return;
    }

    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (request.method === "PATCH" && userMatch) {
      const user = store.updateUser(
        decodeURIComponent(userMatch[1]),
        await readJson(request)
      );
      const runtimeSync = await reconcileUserEntitlements(admin.id);
      sendJson(response, runtimeSync.status === "pending" ? 202 : 200, {
        ...user,
        runtimeSync
      });
      return;
    }

    const hostMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)$/);
    if (request.method === "PATCH" && hostMatch) {
      sendJson(response, 200, store.updateHost(
        decodeURIComponent(hostMatch[1]),
        await readJson(request)
      ));
      return;
    }

    sendJson(response, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
    return;
  };
  const mcpCredentials = new McpCredentials({ store });
  const mcp = createMcpService({
    store, credentials: mcpCredentials, rolePermissions,
    originAllowed: requestOriginIsAllowed, publicOrigin: currentPublicOrigin,
    allowedHosts: () => [...new Set([
      currentPublicOrigin().hostname,
      ...(store.setupStatus().access?.allowedOrigins || []).map((origin) => new URL(origin).hostname)
    ])],
    async dispatch({ admin, method, path, body }) {
      const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      Object.assign(request, { method, url: path, headers: {}, mcp: true });
      const response = new EventEmitter();
      let result;
      response.writeHead = (statusCode) => { response.statusCode = statusCode; };
      response.end = (payload) => {
        result = { statusCode: response.statusCode, body: JSON.parse(payload) };
        response.emit("finish");
      };
      try {
        await handleAdminRequest(request, response, admin);
        return result;
      } catch (error) {
        return { statusCode: error.statusCode || 500, body: { error: {
          code: error.code || (error.statusCode ? "BAD_REQUEST" : "INTERNAL_ERROR"),
          message: error.statusCode ? error.message : "服务器处理请求失败"
        } } };
      }
    }
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, currentPublicOrigin());
      const setup = store.setupStatus();
      const subscriptionOrigin = currentSubscriptionOrigin();
      let requestHostname = "";
      try {
        const forwardedHost = options.trustProxy
          ? String(request.headers["x-forwarded-host"] || "").split(",")[0].trim()
          : "";
        requestHostname = new URL(
          `http://${forwardedHost || request.headers.host || ""}`
        ).hostname;
      } catch {
        requestHostname = "";
      }
      const subscriptionOnlyHost = subscriptionOrigin.hostname !== currentPublicOrigin().hostname
        && requestHostname === subscriptionOrigin.hostname;
      if (
        subscriptionOnlyHost
        && !url.pathname.startsWith("/sub/")
        && !url.pathname.startsWith("/rule-sets/")
      ) {
        sendJson(response, 404, {
          error: { code: "NOT_FOUND", message: "接口不存在" }
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/setup/status") {
        sendJson(response, 200, {
          state: setup.state,
          ...(setup.state === "SETUP_PENDING" ? { expiresAt: setup.expiresAt } : {}),
          ...(setup.state === "INITIALIZING" && setup.progress
            ? { progress: setup.progress }
            : {}),
          version: 1
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/setup/preflight") {
        if (setup.state !== "SETUP_PENDING") {
          throw setupStateError(setup.state);
        }
        const attemptKey = authKey(request, "setup");
        if (!authAllowed(attemptKey)) {
          throw httpError("RATE_LIMITED", "初始化令牌尝试过多，请稍后再试", 429);
        }
        const body = await readJson(request);
        if (!store.verifySetupToken(body.token)) {
          recordAuthFailure(attemptKey);
          throw httpError("SETUP_TOKEN_INVALID", "初始化令牌无效或已经过期", 401);
        }
        const input = normalizeSetupInput(body);
        preserveAutomaticRecoveryOrigin(input);
        input.runtime = store.normalizeHostUpdate("local", input.runtime);
        sendJson(response, 200, await preflightSetup(request, input));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/setup/complete") {
        if (setup.state !== "SETUP_PENDING") {
          throw setupStateError(setup.state);
        }
        const attemptKey = authKey(request, "setup");
        if (!authAllowed(attemptKey)) {
          throw httpError("RATE_LIMITED", "初始化令牌尝试过多，请稍后再试", 429);
        }
        const body = await readJson(request);
        if (!store.verifySetupToken(body.token)) {
          recordAuthFailure(attemptKey);
          throw httpError("SETUP_TOKEN_INVALID", "初始化令牌无效或已经过期", 401);
        }
        const input = normalizeSetupInput(body);
        preserveAutomaticRecoveryOrigin(input);
        input.runtime = store.normalizeHostUpdate("local", input.runtime);
        await preflightSetup(request, input);
        store.beginSetupInitialization();
        let accessActivation = null;
        const originalHost = store.getHost("local");
        try {
          store.updateSetupProgress({ stage: "runtime", current: 1, total: 4, message: "正在自动安装 Runtime、配置协议与 BBR，并验证服务" });
          store.updateHost("local", input.runtime);
          let bbr;
          if (options.runtimeMode === "systemd") {
            const configured = await runLocalRuntimeOperation("首次自动安装", () => runtimeSetupManager.configure());
            bbr = configured.bbr;
          } else bbr = await bbrManager.configure();
          store.updateSetupProgress({
            stage: "access",
            current: 3,
            total: 4,
            message: input.certificate.mode === "caddy-auto"
              ? "正在配置 Caddy 并申请 HTTPS 证书"
              : "正在应用访问入口配置"
          });
          if (input.certificate.mode === "caddy-auto") {
            accessActivation = await setupAccessManager.activate(input);
          }
          store.updateSetupProgress({
            stage: "account",
            current: 4,
            total: 4,
            message: "正在创建管理员并完成初始化"
          });
          const admin = store.completeSetup(input);
          accessActivation = null;
          authAttempts.delete(attemptKey);
          const session = store.createAdminSession(admin.id);
          const finalOrigin = currentPublicOrigin();
          const sameOrigin = requestOriginFor(request) === finalOrigin.origin;
          sendJson(response, 201, {
            state: "READY",
            currentAdmin: admin,
            bbr: bbr.status,
            redirectTo: sameOrigin ? "/" : new URL("/", finalOrigin).toString()
          }, sameOrigin ? {
            "set-cookie": sessionCookie(
              SESSION_COOKIE,
              session.secret,
              session.expiresAt,
              finalOrigin.protocol === "https:"
            )
          } : {});
        } catch (error) {
          if (accessActivation?.rollback) {
            try {
              await accessActivation.rollback();
            } catch (rollbackError) {
              console.error(`[RayLink] Caddy rollback failed: ${rollbackError.message}`);
            }
          }
          store.updateHost("local", { name: originalHost.name, address: originalHost.address, region: originalHost.region });
          store.failSetupInitialization();
          throw error;
        }
        return;
      }

      if (setup.state !== "READY") {
        if (request.method === "GET" && ["/", "/index.html"].includes(url.pathname)) {
          response.writeHead(302, { location: "/setup", "cache-control": "no-store" });
          response.end();
          return;
        }
        if (request.method === "GET" && url.pathname === "/setup/") {
          response.writeHead(302, { location: "/setup", "cache-control": "no-store" });
          response.end();
          return;
        }
        if (
          request.method === "GET"
          && [
            "/setup",
            "/setup/",
            "/setup.js",
            "/setup.css",
            "/styles.css",
            "/assets/brand/raylink-mark.svg"
          ].includes(url.pathname)
          && await sendStatic(response, webDir, url.pathname)
        ) return;
        sendJson(response, 423, {
          error: { code: "SETUP_REQUIRED", message: "请先完成 RayLink 首次初始化" }
        });
        return;
      }

      if (request.method === "GET" && ["/setup", "/setup/"].includes(url.pathname)) {
        response.writeHead(302, { location: "/", "cache-control": "no-store" });
        response.end();
        return;
      }

      if (url.pathname === "/mcp") {
        await mcp.handle(request, response);
        return;
      }

      const ruleSetMatch = url.pathname.match(
        /^\/rule-sets\/(geosite-geolocation-cn\.srs|geoip-cn\.srs)$/
      );
      if (request.method === "GET" && ruleSetMatch) {
        const payload = await ruleSetCache.get(ruleSetMatch[1]);
        if (!payload) {
          sendJson(response, 404, {
            error: { code: "RULE_SET_NOT_READY", message: "完整规则集尚未准备完成" }
          });
          return;
        }
        const etag = `"${createHash("sha256").update(payload).digest("hex")}"`;
        const headers = {
          "cache-control": "public, max-age=3600, must-revalidate",
          "content-type": "application/octet-stream",
          "content-length": payload.length,
          etag,
          "x-content-type-options": "nosniff"
        };
        if (request.headers["if-none-match"] === etag) {
          response.writeHead(304, headers);
          response.end();
          return;
        }
        response.writeHead(200, headers);
        response.end(payload);
        return;
      }

      const subscriptionMatch = url.pathname.match(subscriptionPathRegex);
      if (["GET", "HEAD"].includes(request.method) && subscriptionMatch) {
        const subscriptionUser = store.userForSubscription(subscriptionMatch[1], subscriptionMatch[2]);
        if (!subscriptionUser) {
          sendJson(response, 401, {
            error: { code: "SUBSCRIPTION_INVALID", message: "订阅地址无效或已经被重置" }
          });
          return;
        }
        const format = subscriptionFormatForRequest(
          request,
          url,
          subscriptionFormatForPath(subscriptionMatch[3]) || ""
        );
        if (format === "unsupported") {
          sendJson(response, 400, {
            error: {
              code: "SUBSCRIPTION_FORMAT_UNSUPPORTED",
              message: "订阅格式不受支持"
            }
          });
          return;
        }
        const universalUrl = new URL(
          `/sub/${subscriptionMatch[1]}/${subscriptionMatch[2]}`,
          currentSubscriptionOrigin()
        ).toString();
        if (format === "landing") {
          sendSubscriptionLanding(request, response, universalUrl);
          return;
        }
        const artifactInput = await buildClientConfigForUser(subscriptionUser.id);
        sendSubscriptionArtifact(
          request,
          response,
          buildSubscriptionArtifact({
            format,
            ...artifactInput,
            routePolicy: store.routingPolicy()
          }),
          subscriptionUser
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJson(request);
        const attemptKey = authKey(request, "admin");
        if (!authAllowed(attemptKey)) {
          sendJson(response, 429, { error: { code: "RATE_LIMITED", message: "登录尝试过多，请稍后再试" } });
          return;
        }
        const admin = await store.authenticateAdmin(body.username, body.password);
        if (!admin) {
          recordAuthFailure(attemptKey);
          sendJson(response, 401, { error: { code: "INVALID_CREDENTIALS", message: "用户名或密码不正确" } });
          return;
        }
        authAttempts.delete(attemptKey);
        const session = store.createAdminSession(admin.id);
        sendJson(
          response,
          200,
          { currentAdmin: admin },
          { "set-cookie": sessionCookie(SESSION_COOKIE, session.secret, session.expiresAt, currentPublicOrigin().protocol === "https:") }
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/portal/login") {
        const body = await readJson(request);
        const attemptKey = authKey(request, "portal");
        if (!authAllowed(attemptKey)) {
          sendJson(response, 429, { error: { code: "RATE_LIMITED", message: "登录尝试过多，请稍后再试" } });
          return;
        }
        const user = await store.authenticateUser(body.email, body.password);
        if (!user) {
          recordAuthFailure(attemptKey);
          sendJson(response, 401, { error: { code: "INVALID_CREDENTIALS", message: "邮箱或密码不正确" } });
          return;
        }
        authAttempts.delete(attemptKey);
        if (user.portalStatus !== "active") {
          sendJson(response, 403, { error: { code: "ACCOUNT_NOT_ACTIVE", message: "账号尚未完成首次登录激活" } });
          return;
        }
        const profile = store.portalProfile(user.id);
        if (profile.user.state === "disabled") {
          sendJson(response, 403, { error: { code: "ACCOUNT_DISABLED", message: "账号已经停用" } });
          return;
        }
        const session = store.createUserSession(user.id);
        sendJson(
          response,
          200,
          profile,
          { "set-cookie": sessionCookie(PORTAL_SESSION_COOKIE, session.secret, session.expiresAt, currentPublicOrigin().protocol === "https:") }
        );
        return;
      }

      if (url.pathname.startsWith("/api/portal/")) {
        const sessionSecret = parseCookies(request.headers.cookie)[PORTAL_SESSION_COOKIE];
        const sessionUser = store.userForSession(sessionSecret);
        if (!sessionUser) {
          sendJson(response, 401, { error: { code: "UNAUTHENTICATED", message: "请先登录用户中心" } });
          return;
        }
        const profile = store.portalProfile(sessionUser.id);
        if (profile.user.portalStatus !== "active") {
          sendJson(response, 403, { error: { code: "ACCOUNT_NOT_ACTIVE", message: "用户中心权限已被撤销" } });
          return;
        }
        if (profile.user.state === "disabled") {
          sendJson(response, 403, { error: { code: "ACCOUNT_DISABLED", message: "账号已经停用" } });
          return;
        }
        if (
          !["GET", "HEAD"].includes(request.method)
          && !requestOriginIsAllowed(request)
        ) {
          sendJson(response, 403, {
            error: { code: "ORIGIN_REJECTED", message: "请求来源不受信任" }
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/portal/me") {
          sendJson(response, 200, profile);
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/portal/subscription") {
          sendJson(response, 200, currentSubscription(sessionUser.id));
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/portal/subscription/rotate") {
          const subscription = store.rotateUserSubscription(sessionUser.id);
          sendJson(response, 201, subscriptionDetails(subscription));
          return;
        }
        const portalConfigMatch = url.pathname.match(portalConfigRegex);
        if (request.method === "GET" && portalConfigMatch) {
          const format = resolveSubscriptionFormat(portalConfigMatch[1]);
          const artifactInput = await buildClientConfigForUser(sessionUser.id);
          sendSubscriptionArtifact(
            request,
            response,
            buildSubscriptionArtifact({
              format,
              ...artifactInput,
              routePolicy: store.routingPolicy()
            }),
            profile.user
          );
          return;
        }
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/node/enroll") {
        const body = await readJson(request);
        if (body.encryptionPublicKey) {
          body.encryptionPublicKey = validateNodeEncryptionPublicKey(body.encryptionPublicKey);
        }
        sendJson(response, 201, {
          ...store.enrollNode(body.token, body),
          nextPollSeconds: 10
        });
        return;
      }

      if (url.pathname.startsWith("/api/node/")) {
        const hostId = String(request.headers["x-raylink-host-id"] || "");
        const nodeSecret = bearerToken(request.headers.authorization);
        const node = store.authenticateNode(hostId, nodeSecret);
        if (!node) {
          sendJson(response, 401, {
            error: { code: "NODE_UNAUTHENTICATED", message: "节点身份验证失败" }
          });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/node/heartbeat") {
          const heartbeat = await readJson(request);
          if (heartbeat.encryptionPublicKey) {
            heartbeat.encryptionPublicKey = validateNodeEncryptionPublicKey(
              heartbeat.encryptionPublicKey
            );
          }
          const timestamp = Date.now();
          const lastWriteAt = nodeHeartbeatWrites.get(node.id) || 0;
          if (timestamp - lastWriteAt < nodeHeartbeatMinIntervalMs) {
            sendJson(response, 429, {
              error: { code: "HEARTBEAT_RATE_LIMITED", message: "节点心跳过于频繁" },
              nextPollSeconds: Math.ceil(nodeHeartbeatMinIntervalMs / 1_000)
            }, { "retry-after": String(Math.ceil(nodeHeartbeatMinIntervalMs / 1_000)) });
            return;
          }
          store.heartbeatNode(node.id, heartbeat);
          nodeHeartbeatWrites.set(node.id, timestamp);
          sendJson(response, 200, { nextPollSeconds: 10 });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/node/usage") {
          if (!store.getHost(node.id)?.usageMetering.supported) {
            throw httpError(
              "USAGE_METERING_UNAVAILABLE",
              "该 Runtime 未上报 with_v2ray_api，拒绝接收用户计量数据",
              409
            );
          }
          const usageResult = store.recordUsageSnapshot(
            node.id,
            await readJson(request, 1024 * 1024)
          );
          const runtimeSync = usageResult.quotaExceededUserIds.length
            ? await reconcileUserEntitlements(null, {
              forceCritical: true,
              reason: "usage-quota-enforcement"
            })
            : { status: "current" };
          sendJson(response, 200, { ...usageResult, runtimeSync });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/node/usage/status") {
          const status = await readJson(request);
          if (status.status !== "error") {
            throw httpError("INVALID_USAGE_STATUS", "计量状态只接受 error", 422);
          }
          sendJson(response, 200, {
            usageMetering: store.recordUsageMeteringError(node.id, status.error)
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/node/tasks/next") {
          if (!SUPPORTED_NODE_VERSIONS.includes(node.agentVersion)) {
            sendJson(response, 426, {
              error: {
                code: "NODE_UPGRADE_REQUIRED",
                message: `RayLink Node 必须升级到 ${REQUIRED_NODE_AGENT_VERSION} 后才能接收配置任务`
              },
              requiredVersion: REQUIRED_NODE_AGENT_VERSION
            });
            return;
          }
          const task = store.nextNodeTask(node.id);
          if (!task) {
            response.writeHead(204, { "cache-control": "no-store" });
            response.end();
            return;
          }
          sendJson(response, 200, task);
          return;
        }
        const taskCompletionMatch = url.pathname.match(/^\/api\/node\/tasks\/([^/]+)\/complete$/);
        if (request.method === "POST" && taskCompletionMatch) {
          const completion = store.completeNodeTask(
            node.id,
            decodeURIComponent(taskCompletionMatch[1]),
            await readJson(request)
          );
          if (completion.retryActivation) {
            try {
              await protocolActivationManager.enable({
                hostId: completion.retryActivation.hostId,
                type: completion.retryActivation.type,
                adminId: null
              });
              completion.retryQueued = true;
            } catch (error) {
              console.warn(
                `[RayLink] Remote protocol port retry failed: ${error.message}`
              );
              completion.retryQueued = false;
            }
          }
          sendJson(response, 200, completion);
          return;
        }
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "节点接口不存在" } });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        if (!requestOriginIsAllowed(request)) {
          sendJson(response, 403, {
            error: { code: "ORIGIN_REJECTED", message: "请求来源不受信任" }
          });
          return;
        }
        const sessionSecret = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        store.revokeAdminSession(sessionSecret);
        sendJson(
          response,
          200,
          { loggedOut: true },
          {
            "set-cookie": clearedSessionCookie(
              SESSION_COOKIE,
              currentPublicOrigin().protocol === "https:"
            )
          }
        );
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        const sessionSecret = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        const admin = store.adminForSession(sessionSecret);
        if (!admin) {
          sendJson(response, 401, { error: { code: "UNAUTHENTICATED", message: "请先登录" } });
          return;
        }

        if (
          ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
          && !requestOriginIsAllowed(request)
        ) {
          sendJson(response, 403, {
            error: { code: "ORIGIN_REJECTED", message: "请求来源不受信任" }
          });
          return;
        }

        await handleAdminRequest(request, response, admin);
        return;
      }

      if (request.method === "GET" && await sendStatic(response, webDir, url.pathname)) return;
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "资源不存在" } });
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        error: {
          code: error.code || (error.statusCode ? "BAD_REQUEST" : "INTERNAL_ERROR"),
          message: error.statusCode ? error.message : "服务器处理请求失败"
        }
      });
    }
  });

  return {
    server,
    store,
    runtimeManager,
    protocolActivationManager,
    runtimeSetupManager,
    systemUpdateManager,
    nodeProvisioning,
    async listen({ host, port }) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await sampleLocalTelemetry();
      await refreshLocalRuntimeCapabilities();
      await sampleLocalUsage();
      runOperationalMaintenance();
      operationalMaintenanceTimer = setInterval(
        runOperationalMaintenance,
        operationalMaintenanceIntervalMs
      );
      operationalMaintenanceTimer.unref?.();
      if (backupIntervalMs > 0) {
        backupStartupTimer = setTimeout(
          createInitialBackup,
          Math.max(0, Number(options.backupStartupDelayMs ?? 1_000))
        );
        backupStartupTimer.unref?.();
        backupTimer = setInterval(createScheduledBackup, backupIntervalMs);
        backupTimer.unref?.();
      }
      if (alertIntervalMs > 0) {
        await dispatchOperationalAlerts();
        alertTimer = setInterval(dispatchOperationalAlerts, alertIntervalMs);
        alertTimer.unref?.();
      }
      telemetryTimer = setInterval(sampleLocalTelemetry, telemetryIntervalMs);
      telemetryTimer.unref?.();
      usageMeteringTimer = setInterval(sampleLocalUsage, usageMeteringIntervalMs);
      usageMeteringTimer.unref?.();
      entitlementReconcileTimer = setInterval(() => {
        runLocalRuntimeOperation("配置同步", () => runtimeManager.reconcile()).catch((error) => {
          console.warn(`[RayLink] Entitlement reconciliation failed: ${error.message}`);
        });
      }, entitlementReconcileIntervalMs);
      entitlementReconcileTimer.unref?.();
      ruleSetRefreshTimer = setInterval(refreshRuleSets, 60 * 60 * 1000);
      ruleSetRefreshTimer.unref?.();
      if (runtimeUpdateCheckIntervalMs > 0) {
        refreshRuntimeUpdate();
        runtimeUpdateTimer = setInterval(refreshRuntimeUpdate, runtimeUpdateCheckIntervalMs);
        runtimeUpdateTimer.unref?.();
      }
      if (protocolLatencyIntervalMs > 0) {
        protocolLatencyStartupTimer = setTimeout(sampleProtocolLatencies, 2_000);
        protocolLatencyStartupTimer.unref?.();
        protocolLatencyTimer = setInterval(
          sampleProtocolLatencies,
          protocolLatencyIntervalMs
        );
        protocolLatencyTimer.unref?.();
      }
    },
    async close() {
      if (alertTimer) {
        clearInterval(alertTimer);
        alertTimer = null;
      }
      if (backupTimer) {
        clearInterval(backupTimer);
        backupTimer = null;
      }
      if (backupStartupTimer) {
        clearTimeout(backupStartupTimer);
        backupStartupTimer = null;
      }
      if (protocolLatencyStartupTimer) {
        clearTimeout(protocolLatencyStartupTimer);
        protocolLatencyStartupTimer = null;
      }
      if (protocolLatencyTimer) {
        clearInterval(protocolLatencyTimer);
        protocolLatencyTimer = null;
      }
      if (operationalMaintenanceTimer) {
        clearInterval(operationalMaintenanceTimer);
        operationalMaintenanceTimer = null;
      }
      if (usageMeteringTimer) {
        clearInterval(usageMeteringTimer);
        usageMeteringTimer = null;
      }
      if (runtimeUpdateTimer) {
        clearInterval(runtimeUpdateTimer);
        runtimeUpdateTimer = null;
      }
      if (ruleSetRefreshTimer) {
        clearInterval(ruleSetRefreshTimer);
        ruleSetRefreshTimer = null;
      }
      if (entitlementReconcileTimer) {
        clearInterval(entitlementReconcileTimer);
        entitlementReconcileTimer = null;
      }
      if (telemetryTimer) {
        clearInterval(telemetryTimer);
        telemetryTimer = null;
      }
      if (telemetrySamplePromise) await telemetrySamplePromise;
      if (usageMeteringPromise) await usageMeteringPromise;
      if (protocolLatencyPromise) await protocolLatencyPromise;
      // Stop accepting requests first; then drain tools and close SDK SSE
      // streams before waiting for HTTP connections to finish.
      const httpClosed = server.listening
        ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        : Promise.resolve();
      await nodeProvisioning.close();
      await mcp.close();
      await httpClosed;
      await Promise.allSettled([...backupOperations]);
      store.close();
    }
  };
}
