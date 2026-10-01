#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { normalizeCertificateEmail } from "../server/certificate-settings.js";

export async function completeControlPlaneSetup({
  publicOrigin,
  setupToken,
  credentialsPath,
  domain,
  acmeEmail,
  apiOrigin = "http://127.0.0.1:4173",
  hostName = "RayLink 主控",
  healthTimeoutMs = 60_000,
  retryIntervalMs = 1_000
}) {
  const origin = new URL(publicOrigin);
  const api = new URL(apiOrigin);
  const address = origin.hostname.replace(/^\[|\]$/g, "");
  if (origin.protocol !== "https:" || !isIP(address) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("自动初始化需要有效的服务器 HTTPS IP 根地址");
  }
  if (api.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(api.hostname) || api.username || api.password || api.pathname !== "/" || api.search || api.hash) {
    throw new Error("自动初始化只允许连接本机回环地址");
  }
  if (!credentialsPath || !setupToken) throw new Error("缺少初始化令牌或登录信息保存位置");
  const hostname = String(domain || "").trim().toLowerCase();
  if (hostname && (isIP(hostname) || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname))) {
    throw new Error("RAYLINK_DOMAIN 必须是已解析到主控服务器的域名，不包含协议或路径");
  }
  const canonicalOrigin = hostname ? `https://${hostname}` : origin.origin;
  const certificate = hostname
    ? { mode: "caddy-auto", email: normalizeCertificateEmail(acmeEmail) }
    : { mode: "ip-self-signed" };
  const headers = { host: origin.host, "x-forwarded-proto": "https", "content-type": "application/json" };
  const request = (path, { method = "GET", body, cookie, timeout = 10_000 } = {}) => new Promise((resolve, reject) => {
    const text = body ? JSON.stringify(body) : "";
    // Direct loopback HTTP bypasses public DNS/proxies and preserves the trusted
    // reverse proxy Host/protocol contract without weakening TLS verification.
    const outgoing = httpRequest(new URL(path, api), {
      method, signal: AbortSignal.timeout(timeout),
      headers: { ...headers, ...(cookie ? { cookie } : {}), ...(text ? { "content-length": Buffer.byteLength(text) } : {}) }
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on("data", (chunk) => {
        length += chunk.length;
        if (length > 16 * 1024 * 1024) outgoing.destroy(new Error("初始化接口响应过大"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        let result;
        try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { reject(new Error("初始化接口返回无效 JSON")); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(result.error?.message || `初始化接口返回 HTTP ${response.statusCode}`));
          return;
        }
        resolve({ result, response });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(text);
  });
  const deadline = Date.now() + healthTimeoutMs;
  let state;
  let lastError;
  do {
    try { state = (await request("/api/setup/status")).result.state; break; }
    catch (error) { lastError = error; }
    if (Date.now() < deadline) await delay(Math.min(retryIntervalMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  if (!state) throw new Error(`控制面服务未就绪：${lastError?.message || "响应无效"}`);
  if (!["READY", "SETUP_PENDING"].includes(state)) throw new Error(`无法开始自动初始化：${state}`);

  let identity;
  try { identity = JSON.parse(await readFile(credentialsPath, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw new Error("已保存的初始登录信息无法读取；不会覆盖原有凭据");
    if (state === "READY") throw new Error("控制面已初始化，缺少保存的初始登录信息；不会重置管理员");
    identity = {
      origin: canonicalOrigin,
      admin: { username: "admin", password: `Rl9!${randomBytes(30).toString("base64url")}` },
      notice: "这是首次创建时的登录信息；修改账号后请使用修改后的凭据。"
    };
    await mkdir(dirname(credentialsPath), { recursive: true, mode: 0o700 });
    await writeFile(credentialsPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  if (identity.origin !== canonicalOrigin || typeof identity.admin?.username !== "string"
    || typeof identity.admin?.password !== "string" || identity.admin.password.length < 12) {
    throw new Error("保存的登录信息与当前控制面不匹配；不会覆盖原有凭据");
  }
  await chmod(credentialsPath, 0o600);
  if (state === "SETUP_PENDING") {
    const { result } = await request("/api/setup/complete", {
      method: "POST", timeout: 30 * 60_000,
      body: {
        token: setupToken,
        access: { mode: hostname ? "domain" : "ip", canonicalOrigin, subscriptionOrigin: canonicalOrigin, allowedOrigins: [canonicalOrigin] },
        certificate, admin: identity.admin,
        runtime: { name: hostName, address, region: "default" }
      }
    });
    if (result.state !== "READY") throw new Error("控制面初始化未确认完成");
  }
  const login = await request("/api/auth/login", { method: "POST", body: identity.admin });
  const cookie = login.response.headers["set-cookie"]?.[0]?.split(";")[0];
  if (!cookie) throw new Error("管理员登录未建立会话");
  try {
    const { result } = await request("/api/bootstrap", { cookie });
    if (result.runtime?.mode !== "systemd" || result.runtime?.state !== "running") {
      throw new Error("管理员已创建，但 sing-box Runtime 未确认运行；请在控制台重试自动安装");
    }
    return { ready: true, origin: canonicalOrigin, credentialsPath, warnings: [
      ...(result.runtimeSetup?.warnings || []),
      ...(!hostname ? ["当前使用 IP 自签名证书；受管 Node 通过 SSH 信任该证书，浏览器、MCP 和订阅客户端需要另行信任证书。提供 RAYLINK_DOMAIN 和 RAYLINK_ACME_EMAIL 可自动配置公网可信 HTTPS。"] : [])
    ] };
  } finally {
    await request("/api/auth/logout", { method: "POST", cookie }).catch(() => {});
  }
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const result = await completeControlPlaneSetup({
      publicOrigin: process.env.RAYLINK_PUBLIC_ORIGIN,
      setupToken: process.env.RAYLINK_ONCE_SETUP_TOKEN,
      domain: process.env.RAYLINK_DOMAIN,
      acmeEmail: process.env.RAYLINK_ACME_EMAIL,
      credentialsPath: process.env.RAYLINK_INITIAL_LOGIN_FILE || "/etc/raylink/initial-login.json"
    });
    process.stdout.write(`RayLink 自动初始化完成：${result.origin}\n初始登录信息：${result.credentialsPath}\n`);
    for (const warning of result.warnings) process.stdout.write(`待处理项：${warning}\n`);
  } catch (error) {
    process.stderr.write(`RayLink 自动初始化失败：${error.message}\n`);
    process.exitCode = 1;
  }
}
