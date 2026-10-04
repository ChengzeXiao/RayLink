# AI 出口固定与诊断验收记录

日期：2026-10-04。审查基准：`c896b509f7326f56dfa210bc471e9b86d3f46505`。

本次完成本地实现与验证，未创建新版本、未升级或重启生产服务。此前线上版本为 v0.2.39。

## 功能与使用

智能路由新增“AI 出口与检测”。管理员可按稳定 Host ID 固定 AI 出口，保存后刷新客户端的完整订阅并重新连接。AI 自动组和手选组仅保留该主机已授权、可导出的协议；该主机不可用时拒绝 AI 流量，普通代理组保持原策略。已有自定义规则和全局模式的优先级保留。仅节点订阅不包含路由策略。

检测支持 Claude、ChatGPT / OpenAI、Gemini、Copilot、Perplexity、Grok，区分 DNS、连接、TLS、HTTP、验证页、认证、权限、限流和超时。MCP 可通过 `routing_update` 保存出口，通过 `routing_ai_status` / `routing_ai_check` 读取或执行诊断。

探针只测主控服务器出站，匿名请求固定 HTTPS 目标；无模型调用、账户凭据或 Cookie，不跟随跳转，不接受任意网址。最多三个目标并发，每个目标八秒期限、六十秒短缓存；响应正文最多读取 16 KiB，响应头上限 64 KiB。超过响应头上限单独显示探测限制。诊断结果不会触发出口切换。

## 验证结果

| 验证 | 结果与边界 |
| --- | --- |
| 完整 Node 测试集 | Node 24.15.0，开启原生配置检查：617 项通过，0 失败、0 跳过。 |
| 最终修改专项回归 | 响应头限制修正后，诊断、UI、MCP 相关 29 项全部通过，其中诊断模块 10 项。完整 617 项测试在这一小范围修正前运行。 |
| 原生出口固定矩阵 | sing-box 1.14.2、Mihomo 1.19.25 legacy / modern，各覆盖主机存在、缺失、无授权协议：9 / 9 通过。原始完整配置均能加载。 |
| 故障恢复与隔离 | 固定主机内 TCP / UDP 选择、TCP 故障后同主机恢复、全部固定候选失败时拒绝 AI 流量、普通主机仍可用；其他主机和 DIRECT 泄漏均为 0。 |
| DNS 拒绝行为 | sing-box 固定主机缺失或无授权协议时，AI 及自定义 AI 域名返回 RCODE 5，普通域名返回 RCODE 0。 |
| 负对照 | 故意解除固定后，sing-box 和 Mihomo modern 的原生验收按预期失败，确认能捕获其他主机混入。 |
| 既有 AI DNS 分流 | Mihomo legacy / modern 的 AI 依赖域名、相邻域名及自定义覆盖规则检查通过。 |
| 管理界面 | 隔离数据库及模拟探针下，真实浏览器登录、保存固定主机、刷新保留、检测结果显示、解除固定通过；桌面和 390 px 窄屏检查通过，无 JavaScript 错误或横向溢出。 |
| 权限与兼容 | REST / MCP 访问控制、只读令牌、无效输入、缺失主机、旧客户端保存不解除固定均有回归覆盖。 |

原生矩阵使用真实核心和回环 HTTP 故障夹具验证选择逻辑；协议传输被替换为夹具，不能当作公网 VLESS / Hysteria2 等协议或手机网络验收。Egern 覆盖配置回归，未运行真实 Egern 客户端。

## VPS-A 匿名观察

使用生产主机 Node 22.23.1 临时执行独立探针，未安装文件、发布配置或重启服务。以下是当次主控出站观察，结果可能随时间变化：

| 目标 | 响应 |
| --- | --- |
| Claude 网站、ChatGPT 网站、Perplexity | HTTP 403，识别为网站验证页。 |
| Claude API、OpenAI API | HTTP 401，需要认证；未提供 API Key。 |
| Copilot、Grok | HTTP 200。 |
| Gemini | 最初触发探针 16 KiB 响应头上限；扩大至 64 KiB 并增加限制分类后，复测 HTTP 200，约 222 ms。 |

验证页不证明账户封禁，401 不证明 API 故障，200 不证明登录或模型生成成功。上述延迟是 VPS 到目标的单次观察，不能代表客户端端到端延迟。

## 审查与未验证边界

- Standards / 安全审查：已修正超时阶段归类问题；最终无未解决发现。
- Spec 审查：无未解决发现。
- 本次不提供账户不被封禁、线路不被阻断或所有 AI 业务永久可用的保证。
- 尚未验证手机蜂窝网络、真实账户登录、付费模型请求或持续对话稳定性。
- 固定 Host 不保证其 NAT 公网 IP 永不变化；第二入口和线路容灾仍需要独立 VPS。
- 跨客户端连续失败计数、恢复冷却及严格会话粘性未在本次新增，沿用现有核心的 fallback / URLTest 行为。

## 复跑入口

```sh
RAYLINK_NATIVE_CHECK=1 SING_BOX_BIN=/path/to/sing-box-1.14.2 \
  node --test --test-concurrency=1 tests/*.test.js

node --test tests/ai-diagnostics.test.js tests/ai-routing-ui.test.js \
  tests/mcp.test.js tests/mcp-tools.test.js

SING_BOX_BIN=/path/to/sing-box-1.14.2 MIHOMO_BIN=/path/to/mihomo \
  node tests/ai-egress-check.mjs
```

`check:ai` 已包含新的出口固定原生验收。负对照可增加 `--core=sing-box --negative-control-unpinned`，预期退出码为 1。
