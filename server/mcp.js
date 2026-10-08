import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { McpOperations } from "./mcp-operations.js";
import { mcpTools } from "./mcp-tools.js";

function json(response, status, error, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify({ error }));
}

function result(body, failed = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    ...(failed ? { isError: true } : {})
  };
}

function safeBusinessError(response) {
  const candidate = response.body?.error?.code;
  const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate || "") ? candidate : "ACTION_FAILED";
  const explanations = {
    USER_EXISTS: "该邮箱的用户已存在，请查询现有用户",
    FORBIDDEN: "当前管理员角色无权执行此操作",
    RUNTIME_OPERATION_IN_PROGRESS: "Runtime 正在执行其他操作，请等待完成后检查状态",
    RUNTIME_ALREADY_CURRENT: "Runtime 已是可用的最新版本",
    NODE_NOT_ENROLLED: "请先安装 RayLink Node 并完成节点接入",
    HOST_CAPABILITIES_UNKNOWN: "等待节点上报 Runtime 能力后再配置协议",
    PROTOCOL_UNAVAILABLE: "当前 Runtime 版本、平台或构建能力不支持该协议",
    PROVISIONING_PUBLIC_ORIGIN: "先配置 VPS 可访问且证书可信的控制面 HTTPS 根地址",
    INVALID_SSH_CREDENTIALS: "提供密码或私钥中的一种认证方式，必要时附带 sudo 密码",
    PROVISIONING_BUSY: "已有节点正在接入，请完成后再试",
    PROVISIONING_RETRY_REQUIRED: "该服务器已有失败或中断任务；先查询接入列表，再对原 job 调用 retry",
    PROVISIONING_REQUEST_CONFLICT: "请求编号已用于其他接入参数，请先查询已有任务",
    PROVISIONING_RETRY_NOT_ALLOWED: "仅失败或中断的任务可以显式重试；先查询原 job 状态",
    LAST_OWNER_REQUIRED: "系统必须至少保留一个 Owner"
  };
  return { error: { code, statusCode: response.statusCode,
    message: explanations[code] || "操作未完成，请根据错误码检查参数及控制面中的详细状态" } };
}

export function createMcpService({ store, credentials, rolePermissions, originAllowed, allowedHosts, publicOrigin, dispatch }) {
  const journal = new McpOperations(store);
  const active = new Map();
  const operations = new Set();
  const permitted = (principal, tool) => principal
    && rolePermissions.get(principal.admin.role)?.has(tool.permission)
    && tool.requiresScopes.every((scope) => principal.scopes.includes(scope))
    && (!tool.secret || rolePermissions.get(principal.admin.role)?.has("secrets.read"));

  const execute = async (auth, tool, args) => {
    // Re-read revocation, expiry and role immediately before performing the operation.
    const principal = credentials.authenticate(auth.token);
    if (!permitted(principal, tool)) {
      return result({ error: { code: "FORBIDDEN", message: "令牌已失效或当前权限不足" } }, true);
    }
    const started = Date.now();
    let statusCode = 500;
    let replayed = false;
    try {
      const perform = async () => {
        const response = await dispatch({ admin: principal.admin, ...tool.request(args) });
        const body = response.statusCode >= 400 ? safeBusinessError(response) : tool.select(response.body, args);
        if (!body || typeof body !== "object") throw new Error("Invalid tool result");
        if (body.enrollmentToken && body.host) {
          const origin = publicOrigin().origin;
          const quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
          body.enrollment = {
            server: origin,
            command: `curl -fsSL ${quote(`${origin}/node/install.sh`)} | sudo env RAYLINK_SERVER=${quote(origin)} RAYLINK_ENROLL_TOKEN=${quote(body.enrollmentToken)} bash`,
            status: "awaiting-node-installation",
            note: "在新 VPS 上执行安装命令；需要该 VPS 能访问的控制面 HTTPS 地址。等待首次心跳及协议探测通过后再判断可用。"
          };
        }
        return { statusCode: response.statusCode, body };
      };
      const completed = tool.mutating
        ? await journal.run({ principal, token: auth.token, tool, args }, perform)
        : { value: await perform(), replayed: false };
      replayed = completed.replayed;
      statusCode = completed.value.statusCode;
      return result(completed.value.body, statusCode >= 400);
    } catch (error) {
      statusCode = error.statusCode || 500;
      return result({ error: {
        code: error.statusCode ? error.code : "OPERATION_OUTCOME_UNKNOWN",
        message: error.statusCode ? error.message : "操作结果尚不能确认，请检查系统状态，不要换编号盲目重试"
      } }, true);
    } finally {
      try {
        store.recordAuditEvent({
          adminId: principal.adminId, actorUsername: principal.admin.username, actorRole: principal.admin.role,
          action: `MCP ${tool.name}`, resourceType: "mcp", resourceId: principal.id,
          metadata: { transport: "mcp", tokenId: principal.id, tool: tool.name,
            requestId: args.requestId || null, statusCode, replayed, durationMs: Date.now() - started }
        });
      } catch {
        console.warn("[RayLink] MCP audit event could not be recorded");
      }
    }
  };

  const handler = createMcpHandler(({ authInfo }) => {
    const principal = authInfo.extra.principal;
    const server = new McpServer({ name: "raylink", version: "1.0.0" }, {
      instructions: "RayLink 管理工具。先读取现状再修改；配置发布后检查 deployments/readiness，queued 或 pending 不代表节点已生效。所有写操作必须使用唯一 requestId；同一操作网络重试沿用原 requestId。机密输出仅按任务需要使用，勿写入公开内容。"
    });
    for (const tool of mcpTools.filter((entry) => permitted(principal, entry))) {
      server.registerTool(tool.name, {
        description: tool.description, inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: !tool.mutating, destructiveHint: tool.mutating,
          idempotentHint: true, openWorldHint: false }
      }, (args) => {
        const promise = execute(authInfo, tool, args);
        operations.add(promise);
        promise.finally(() => operations.delete(promise)).catch(() => {});
        return promise;
      });
    }
    return server;
  }, { legacy: "stateless", responseMode: "auto", maxRequestBodySize: 256 * 1024 });
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: 256 * 1024 });
  return {
    async handle(request, response) {
      if (!hostHeaderValidation(allowedHosts())(request, response)) return;
      if (!originAllowed(request)) {
        json(response, 403, { code: "ORIGIN_REJECTED", message: "请求来源不受信任" });
        return;
      }
      const token = String(request.headers.authorization || "").match(/^Bearer\s+(\S+)$/i)?.[1];
      const principal = token ? credentials.authenticate(token) : null;
      if (!principal) {
        json(response, 401, { code: "UNAUTHENTICATED", message: "需要有效的 MCP Bearer 令牌" },
          { "www-authenticate": 'Bearer realm="RayLink MCP"' });
        return;
      }
      const count = active.get(principal.id) || 0;
      const total = [...active.values()].reduce((sum, value) => sum + value, 0);
      if (count >= 8 || total >= 32 || operations.size >= 32) {
        json(response, 429, { code: "MCP_BUSY", message: "并发请求过多，请稍后重试" }, { "retry-after": "2" });
        return;
      }
      active.set(principal.id, count + 1);
      response.setHeader("cache-control", "no-store");
      request.auth = { token, clientId: principal.id, scopes: principal.scopes, extra: { principal } };
      try { await nodeHandler(request, response); }
      finally {
        const remaining = active.get(principal.id) - 1;
        if (remaining) active.set(principal.id, remaining); else active.delete(principal.id);
      }
    },
    async close() {
      await Promise.allSettled([...operations]);
      await handler.close();
    }
  };
}
