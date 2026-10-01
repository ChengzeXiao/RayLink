# HTTP MCP Server

RayLink 的 `/mcp` 与控制面共用 HTTP 服务和业务操作，供支持 Streamable HTTP 的 Agent 管理现有系统。生产环境沿用控制面的 HTTPS 反向代理；本地可以使用 `http://127.0.0.1:4199/mcp`。

## 接入

1. Owner 登录控制面，打开 **系统 → MCP / Agent**。
2. 创建有名称和有效期的凭据，勾选需要的权限。默认只读；读取密钥、管理管理员分别显式授权。
3. 复制只显示一次的令牌和连接配置，填入 Agent 的 MCP 设置。后续列表仅显示凭据元数据，无法找回令牌；需要时撤销并重新签发。
4. Agent 先调用 `system_overview`、`users_list`、`hosts_list`、`readiness_get` 了解现状，再执行具体管理动作。

通用连接示例（各客户端配置字段略有不同，以其 HTTP MCP 配置为准）：

```json
{
  "mcpServers": {
    "raylink": {
      "type": "http",
      "url": "https://raylink.example.com/mcp",
      "headers": { "Authorization": "Bearer <从界面复制的令牌>" }
    }
  }
}
```

支持静态 Bearer Header 的客户端可直接接入。本版本没有 OAuth 授权服务器，不适用于仅允许 OAuth 登录且不能配置 Header 的客户端。

## 功能覆盖

| 分类 | MCP 工具 |
|---|---|
| 系统概况与诊断 | `system_overview`, `alerts_get`, `readiness_get` |
| 用户与权益 | `users_list`, `users_get`, `users_create`, `users_update`, `users_reset_password` |
| 客户端订阅 | `users_subscription_get`, `users_subscription_rotate`，返回所有现有客户端格式的专属 URL |
| Host 接入与升级 | `hosts_list`, `hosts_get`, `hosts_create`, `hosts_update`, `hosts_enrollment_rotate`, `hosts_runtime_upgrade` |
| 入口协议 | `hosts_protocol_get`, `hosts_protocol_update`, `hosts_protocol_activate`, `hosts_protocol_measure` |
| 智能分流 | `routing_get`, `routing_update`, `routing_diagnose` |
| 证书设置 | `certificate_get`, `certificate_update` |
| 本地 Runtime | `runtime_status`, `runtime_installation`, `runtime_update_check`, `runtime_install`, `runtime_upgrade`, `runtime_reality_keypair` |
| 配置发布 | `deployments_list`, `deployments_preview`, `deployments_publish`, `deployments_rollback` |
| 备份 | `backups_list`, `backups_create`, `backups_verify` |
| 管理员与审计 | `admins_list`, `admins_create`, `admins_update`, `audit_list` |

共 42 个工具，覆盖当前已存在的管理员业务操作。初始化、登录会话、MCP 凭据签发/撤销保留在可信的控制面界面；Node 心跳、任务回执属于 Node 自己的认证协议。没有任意 HTTP 转发、Shell 执行、数据库 SQL 或文件读写工具。

`hosts_create` 返回 Host、一次性 enrollment token 和 VPS 安装命令；它不会 SSH 登录 VPS。自动 SSH 安装仍属于后续功能。安装成功、心跳上线、协议探测通过、流量计量正常是不同状态，Agent 不应把“已创建记录”当成“节点可用”。

## 权限和输出

有效权限为 **令牌 scope ∩ 当前管理员角色权限**。每个 HTTP 请求和工具执行前均重新检查到期、撤销及当前角色；降权无需重启服务。`tools/list` 只列出当前可调用的工具，手工猜测工具名不能越权。

- `read`：无密钥的业务查询。
- `users.manage`：创建/修改用户、服务权益和门户密码。
- `runtime.manage`：Host、协议、分流、发布、Runtime 运维。
- `system.manage`：证书设置、备份创建与校验。
- `admins.manage`：管理员管理；具有此权限的 Owner Agent 可创建新的高权限管理员，应仅为此类任务授予。
- `audit.read`：审计查询。
- `secrets.read`：在对应业务权限基础上返回订阅地址、节点注册令牌、完整协议配置或 Reality 私钥。Auditor 不获得此能力。

普通输出选取业务字段并剔除嵌套密钥、原始配置和原始错误。敏感工具明确声明额外 scope。只读令牌无法签发更多凭据；MCP 不接受浏览器 Cookie 作为认证。

## 写入、重试与失败

所有写工具要求 1–128 字符的 `requestId`（字母/数字起始，允许 `_.:-`），用于标识一次业务操作。参数结构由工具 schema 给出，未知字段会被拒绝。

```json
{
  "name": "users_create",
  "arguments": {
    "requestId": "create-alice-20261001-001",
    "name": "Alice",
    "email": "alice@example.com",
    "quotaGb": 100,
    "nodeScope": ["all"],
    "expiresAt": "2027-10-01"
  }
}
```

- 同一令牌、同一编号、同一参数：共享正在执行的操作，或返回已完成结果；服务重启后仍可重放。
- 同编号换工具/参数：`REQUEST_ID_CONFLICT`，不执行。
- 写入前将操作认领持久化；在业务执行后、结果落盘前进程异常退出，返回 `OPERATION_OUTCOME_UNKNOWN`。这时必须通过对应查询工具核对实际状态，不能通过换编号盲目重试。对外部 Runtime 的操作不承诺跨进程崩溃的 exactly-once。
- 已完成结果（包括业务错误）绑定原编号。确认需要再次尝试失败操作时，使用新编号；网络超时或响应丢失继续使用原编号。
- 换令牌会进入新的编号空间，不能跨令牌靠同编号去重。
- 请求断开不会撤销已经提交的业务变更；已开始的任务继续完成并保存结果。

令牌仅存 SHA-256 哈希。请求指纹使用以令牌派生密钥的 HMAC，结果以令牌派生密钥 AES-256-GCM 加密；数据库及审计不保存请求参数、令牌明文或接入令牌明文。请求记录在凭据存在期间保留，避免重启/长时间重试造成重复操作；撤销凭据立即阻止其读取或重放。

业务结果保留既有含义：用户返回 `runtimeSync.pending` 说明已保存但发布待重试；远程 `queued` 仅表示排队；dry-run 下生成了配置不等于服务正在运行。修改路由会替换完整规则数组，先读取并合并需要保留的规则。

## HTTP 与部署

使用官方 TypeScript SDK Server/Client 2.2.0、Node Adapter 2.1.0。支持 2026-07-28 协议及 2025 无会话 Streamable HTTP 兼容模式；没有旧式独立 `/sse` 端点。GET/DELETE 会话操作返回 405；无需在负载均衡器中保持 MCP 会话亲和，但多实例仍须遵守 RayLink 本身的 SQLite/Runtime 单控制面部署约束。

来源检查使用控制面允许的 Origin，Host 按控制面主机名限制以防 DNS rebinding。无浏览器 Origin 的已认证 Agent 请求可用；不开放跨域 CORS。正文最大 256 KiB，单令牌最多 8 个并发 HTTP 请求、全局最多 32 个，同时限制尚未完成的工具操作。HTTP 429 返回重试间隔；设置 Agent 写操作超时以覆盖 Runtime 安装/升级所需时间。

界面 REST：`GET/POST /api/mcp/tokens`、`DELETE /api/mcp/tokens/:id`，仅 Owner 使用登录会话访问，签发默认 30 天，可选 1–365 天，凭据绑定签发者。MCP 审计记录工具名、操作者、凭据 ID、请求 ID、结果码、是否重放及耗时；不记录请求体或敏感结果。

首次源码启动先执行 `npm ci --ignore-scripts`。发布包携带锁定生产依赖及 lockfile，安装/升级在候选目录校验依赖与实际模块导入；预检失败不会停止旧服务。远程 RayLink Node 不增加 MCP 依赖。

协议依据：[官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[HTTP 服务适配文档](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)、[MCP 2026-07-28 传输规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)。

## 验收

测试边界为真实 HTTP、官方 MCP 客户端、管理 API、持久化凭据和浏览器管理界面。测试使用隔离 SQLite 和 dry-run Runtime；不能以这些测试代替公网 VPS 接入、生产 systemd 安装/升级或移动网络实测。

验证命令：`node --test tests/mcp.test.js tests/mcp-tools.test.js tests/mcp-credentials.test.js`，完整回归 `npm run check`。发布包测试验证离线依赖加载和依赖异常时不切换服务。2026-10-01 本地验收：`npm run check` **353/353 通过**（含完整既有 API 回归）。官方 MCP SDK 客户端、2025 HTTP 握手、令牌撤销/降权、跨重启密文重放、真实 SIGKILL 和 HTTP 断线恢复、SSE 关停、错误脱敏均通过。MCP 工作流实际覆盖用户及订阅、Host 登记、路由与证书、协议配置、dry-run 发布/回滚、备份校验、管理员及体检查询。桌面界面完成创建/一次性显示/清除/撤销，390px 视口无横向溢出。

审查以 `c0e2373` 为基线；独立 Standards 与 Spec 复核完成。发现的 SSE 关停阻塞和 Runtime 原始错误泄露均已修复并加入回归。真实远端安装、生产服务切换和移动网络质量未在本轮执行；42 工具的 schema/映射覆盖不等于每个外部运维动作都完成了生产实测。
