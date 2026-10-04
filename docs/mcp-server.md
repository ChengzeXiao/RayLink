# MCP Server — Streamable HTTP

RayLink 的 `/mcp` 与控制面共用 HTTP 服务和业务操作，供支持 Streamable HTTP 的 Agent 管理现有系统。生产环境沿用控制面的 HTTPS 反向代理；本地可以使用 `http://127.0.0.1:4199/mcp`。

## 接入

1. Owner 登录控制面，打开 **系统 → MCP Server**。
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

界面展示 Streamable HTTP、Endpoint 和 Bearer Token；通用 JSON 中 `type` 保持客户端通用的 `http`。支持静态 Bearer Header 的客户端可直接接入。本版本没有 OAuth 授权服务器，不适用于仅允许 OAuth 登录且不能配置 Header 的客户端。

## 管理员账号

右上角个人菜单的「账号设置」向全部管理员角色开放。修改登录名或密码须输入当前密码，新密码为 12–1024 位、不能与旧密码相同或全为空白；成功后清除当前 Cookie 并撤销该账号全部浏览器会话，须重新登录。用户名更改保留 MCP Token，密码修改及 Owner 重置密码会立即撤销该账号未撤销的 MCP Token；需要重新签发 Agent 凭据。

Owner 在管理员列表可修改其他管理员登录名、角色、密码。本人登录名/密码只通过账号设置修改，REST 管理员 PATCH 和 `admins_update` 均不能绕过当前密码校验。保留最后一位 Owner，拒绝重复登录名，异步登录/账号更新并发时以当前凭据为准。

个人 REST：`PATCH /api/account/profile {currentPassword,username}`、`POST /api/account/password {currentPassword,newPassword}`。不提供读取现有密码的接口。

## 功能覆盖

| 分类 | MCP 工具 |
|---|---|
| 系统及 Node 更新 | `system_update_check`, `system_upgrade`, `hosts_node_upgrade` |
| BBR 配置 | `hosts_bbr_configure` |
| 系统概况与诊断 | `system_overview`, `alerts_get`, `readiness_get` |
| 用户与权益 | `users_list`, `users_get`, `users_usage_history`, `users_create`, `users_update`, `users_reset_password` |
| 客户端订阅 | `users_subscription_get`, `users_subscription_rotate`，返回所有现有客户端格式的专属 URL |
| Host 接入与升级 | `hosts_list`, `hosts_get`, `hosts_create`, `hosts_update`, `hosts_enrollment_rotate`, `hosts_runtime_upgrade` |
| SSH 自动接入 | `hosts_provision_start`, `hosts_provision_list`, `hosts_provision_get`, `hosts_provision_retry` |
| 入口协议 | `hosts_protocol_get`, `hosts_protocol_update`, `hosts_protocol_activate`, `hosts_protocol_measure` |
| 智能分流 | `routing_get`, `routing_update`, `routing_diagnose`, `routing_ai_status`, `routing_ai_check` |
| AI 出口二选一 | `routing_ai_egress_get`, `routing_ai_egress_update`, `routing_ai_egress_publish` |
| AI 上游兼容接口 | `routing_ai_upstream_get`, `routing_ai_upstream_update`, `routing_ai_upstream_publish` |
| 证书设置 | `certificate_get`, `certificate_update` |
| 节点域名自动化 | `node_domains_get`, `node_domains_update` |
| 本地 Runtime | `runtime_status`, `runtime_installation`, `runtime_update_check`, `runtime_install`, `runtime_upgrade`, `runtime_reality_keypair` |
| 配置发布 | `deployments_list`, `deployments_preview`, `deployments_publish`, `deployments_rollback` |
| 备份 | `backups_list`, `backups_create`, `backups_verify` |
| 管理员与审计 | `admins_list`, `admins_create`, `admins_update`, `audit_list` |

共 53 个工具，覆盖当前已存在的管理员业务操作。初始化、登录会话、MCP 凭据签发/撤销保留在可信的控制面界面；Node 心跳、任务回执属于 Node 自己的认证协议。SSH 接入只执行固定的安装流程，没有任意 HTTP 转发、Shell 命令、数据库 SQL 或文件读写工具。

`hosts_create` 返回手动接入的 Host、一次性 enrollment token 和 VPS 安装命令。使用 `hosts_provision_start` 可[通过 SSH 自动安装、配置协议并验证订阅](ssh-node-provisioning.md)，传入 IP、SSH 用户与密码或私钥即可。启动调用返回持久任务，随后使用 `hosts_provision_get` 检查结果；安装成功、心跳上线、协议探测通过、流量计量正常分别验证。没有有效用户时结果明确标为 `awaiting-users`。

`runtime_install` 会完成 Runtime 安装、默认协议配置、BBR 尝试、发布及运行检查。BBR 支持情况、安装进度、系统和 Node 更新任务状态可从概况/主机查询中读取。更新任务在独立服务中执行，提交成功不代表更新完成；以重启后的任务结果和实际版本为准。

## 月度额度

流量额度按 Asia/Shanghai 自然月重置。用户查询中的 `usagePeriod` 给出当期月份和下次重置时间，`usedGb` 为本期用量。`users_usage_history` 使用 `read` 权限查询当期、历史月份、旧版本累计归档与人工调整记录。初次升级会先归档旧累计，再清零；以后每月 1 日 00:00 自动重置。显式修改已用流量时，可给 `users_update` 同时传 `usagePeriodKey`，周期已变化则返回 `USAGE_PERIOD_CHANGED`，刷新用户后再决定是否调整。详见[月度计量](monthly-usage.md)。

## 权限和输出

有效权限为 **令牌 scope ∩ 当前管理员角色权限**。每个 HTTP 请求和工具执行前均重新检查到期、撤销及当前角色；降权无需重启服务。`tools/list` 只列出当前可调用的工具，手工猜测工具名不能越权。

- `read`：无密钥的业务查询。
- `users.manage`：创建/修改用户、服务权益和门户密码。
- `runtime.manage`：Host、协议、分流、发布、Runtime 运维。
- `hosts.provision`：SSH 自动接入和重试；同时需要 `runtime.manage`。此权限需单独勾选，不进入现有预设。
- `system.manage`：证书、节点 DNS 自动化设置、备份创建与校验、系统及 Node 程序升级（Owner）。
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

`routing_update` 可传 `aiExit: { mode: "pinned", hostId: "local" }` 固定 AI 出口主机，或 `mode: "auto"` 解除固定；省略 `aiExit` 保留原设置。用户需刷新完整订阅，固定主机不可用或不在用户授权范围内时 AI 失败关闭，普通流量保持原策略。自定义规则及全局模式仍按既有优先级执行。

`routing_ai_check` 接受预设 `service`（`all`、`claude`、`openai`、`gemini`、`copilot`、`perplexity`、`grok`），需 `runtime.manage`；`routing_ai_status` 仅需 `read`。检测匿名访问固定网址，不发模型请求，复用短缓存，不改变路由。结果标记 `control-plane-egress`，仅证明主控服务器出站观察，不证明远程 Host、客户端协议、账户或模型可用。最近结果只保存在进程内，重启后清空。

使用官方 TypeScript SDK Server/Client 2.2.0、Node Adapter 2.1.0。支持 2026-07-28 协议及 2025 无会话 Streamable HTTP 兼容模式；没有旧式独立 `/sse` 端点。GET/DELETE 会话操作返回 405；无需在负载均衡器中保持 MCP 会话亲和，但多实例仍须遵守 RayLink 本身的 SQLite/Runtime 单控制面部署约束。

来源检查使用控制面允许的 Origin，Host 按控制面主机名限制以防 DNS rebinding。无浏览器 Origin 的已认证 Agent 请求可用；不开放跨域 CORS。正文最大 256 KiB，单令牌最多 8 个并发 HTTP 请求、全局最多 32 个，同时限制尚未完成的工具操作。HTTP 429 返回重试间隔；设置 Agent 写操作超时以覆盖 Runtime 安装/升级所需时间。

界面 REST：`GET/POST /api/mcp/tokens`、`DELETE /api/mcp/tokens/:id`，仅 Owner 使用登录会话访问，签发默认 30 天，可选 1–365 天，凭据绑定签发者。MCP 审计记录工具名、操作者、凭据 ID、请求 ID、结果码、是否重放及耗时；不记录请求体或敏感结果。

首次源码启动先执行 `npm ci --ignore-scripts`。发布包携带锁定生产依赖及 lockfile，安装/升级在候选目录校验依赖与实际模块导入；预检失败不会停止旧服务。远程 RayLink Node 不增加 MCP 依赖。

协议依据：[官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[HTTP 服务适配文档](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)、[MCP 2026-07-28 传输规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)。

## 验收

测试边界为真实 HTTP、官方 MCP 客户端、管理 API、持久化凭据和浏览器管理界面。测试使用隔离 SQLite 和 dry-run Runtime；不能以这些测试代替公网 VPS 接入、生产 systemd 安装/升级或移动网络实测。

验证命令：`node --test tests/mcp.test.js tests/mcp-tools.test.js tests/mcp-credentials.test.js`，完整回归 `npm run check`。发布包测试验证离线依赖加载和依赖异常时不切换服务。2026-10-01 本地验收：`npm run check` **353/353 通过**（含完整既有 API 回归）。官方 MCP SDK 客户端、2025 HTTP 握手、令牌撤销/降权、跨重启密文重放、真实 SIGKILL 和 HTTP 断线恢复、SSE 关停、错误脱敏均通过。MCP 工作流实际覆盖用户及订阅、Host 登记、路由与证书、协议配置、dry-run 发布/回滚、备份校验、管理员及体检查询。桌面界面完成创建/一次性显示/清除/撤销，390px 视口无横向溢出。

初始 MCP 审查以 `c0e2373` 为基线，独立 Standards 与 Spec 复核完成；本次 SSH 扩展以 `e5ef11d` 为基线。SSH 扩展新增了真实 SDK 的启动/查询/重放和单独 scope 验证，以及 Node 注册、发布、计量和订阅的模拟闭环。真实公网 VPS 安装、生产服务切换和移动网络质量仍需环境实测；工具的 schema/映射覆盖不等于每个外部运维动作都完成了生产验收。

2026-10-01 MCP Server / 账号 / 域名自动化验收（基线 `8b49e2d`）：`npm run check` 共 451 项，450 通过、0 失败、1 项原生环境检查默认跳过；该项已另以真实 sing-box 1.14.2 运行并通过。覆盖密码/登录并发、会话与 MCP Token 撤销、DNS 设置作用域和幂等、Cloudflare A/AAAA 与错误 Zone 恢复、DNS 传播失败续接、协议继承及五种订阅格式；QUIC 的 UDP 激活、监听、防火墙和测量经过专项回归。Standards / Spec 复核发现的问题已修复，无剩余已确认 P1/P2。桌面 UI 完成只读验收，表单提交由公开 handler 和 HTTP 测试覆盖；本轮未进行公网 DNS/CA/VPS 写入、生产部署或移动网络实测。


### AI 出口二选一

`routing_ai_egress_get` 读取保存的 `mode`（`server`/`residential`）、`aiExit`、脱敏 `upstream` 和 `runtimeSync`。`publishedMode` 表示最近成功发布快照中的出口方式；`status=pending` 不表示新设置生效，`runtimeMode=dry-run` 只表示模拟记录，也不证明客户端已刷新订阅。

`routing_ai_egress_update` 需要 `runtime.manage` 和唯一 `requestId`。服务器模式只接受可选 `aiExit`，住宅模式只接受可选 `upstream`；同一个请求不能混传两者。示例：

```json
{"requestId":"choose-server-1","mode":"server","aiExit":{"mode":"pinned","hostId":"local"}}
```

```json
{"requestId":"choose-residential-1","mode":"residential","upstream":{"type":"socks5","server":"proxy.example.com","port":1080}}
```

可配置 `http`/`https`、`username`、写入专用 `password` 和 HTTPS 的 `tlsServerName`；密码省略/留空保留，`clearPassword:true` 显式清除。服务器模式停止使用住宅上游并保留凭据；住宅模式固定 smart/local，仅 AI 专用域名使用上游，普通 Google/浏览保留原出口。发布失败后用 `routing_ai_egress_publish` 加新 `requestId` 重试；同一次请求的传输重试复用原 `requestId`。旧 `routing_ai_upstream_*` 和 `routing_update` 保持兼容。


### AI 域名识别与发布状态（v0.2.43）

`routing_get` 返回 `aiDomainRules`（version、内置 domainNames/domainSuffixes、sharedDomains、protectedDomains 和有序 customRules）。`routing_update` 继续接受完整规则数组；域名类 AI 规则同步住宅 Runtime，返回 `runtimeSync`。状态 not-required 表示住宅未启用、不需要发布 Runtime；current/pending/simulated 分别表示已确认、待发布、仅模拟。发布失败可用 `routing_ai_egress_publish` 重试，刷新完整客户端订阅仍需在客户端完成。

`routing_diagnose` 的 `aiDomain` 包含 eligible/source/match/value/ruleId/reason、desiredEgress、runtimeSync 与规则版本。desiredEgress 可为 server/residential/blocked/client-direct；仅规则推断，不证明实际客户端出口。IP/CIDR 自定义规则不扩充住宅域名范围，共享普通域名有独立保护。工具数和权限不变。
