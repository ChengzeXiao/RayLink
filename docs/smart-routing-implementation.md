# 智能分流修复与模拟验收

日期：2026-10-01。基线：`ec468a4`。对应 [优化方案](smart-routing-optimization-plan.md)，源码版本仍为未发布的 0.2.33。本轮没有部署线上或改动系统 VPN/TUN。

## 已实现的规则

默认顺序：本地通信与 DNS → 显式自定义规则 → AI → 明确境外域名 → 国内域名 → 解析后判断私网/国内 IP → 默认代理。直连、全局代理模式同样保留自定义例外。代理故障不会自动变为 DIRECT。

- sing-box 对 SOCKS/HTTP 域名目标补充 `resolve`；首条自定义 IP 规则前解析，后续沿用这组已检查地址，避免重复解析和 TTL=0 轮转绕过高优先级 IP 规则。显式域名 DNS、AI DNS 与境外 DNS 的结果参与真实代理拨号，不只是配置中存在一条 DNS 规则。
- 系统 DNS、国内 DoH、普通代理加密 DNS、AI 加密 DNS 分开。节点拨号继续使用独立 bootstrap/已解析地址，避免循环依赖。本地域名解析不使用乐观过期缓存。
- sing-box 普通默认选择 TCP 测速池，每分钟探测；保留智能混选、UDP 和手动入口。原生 URLTest 根据业务 TCP/UDP 能力选择候选，TCP-only Shadowsocks 仍不会伪装成支持 UDP relay。
- AI 独立稳定组：sing-box 使用 TCP 候选及 15000ms 容差，每分钟探测，健康出口不因小幅时延变化切换；失败后选择备用。没有 TCP 候选时使用可用候选。Mihomo/Egern 使用独立有序 fallback，主节点恢复可能回切；各端都可手动固定具体节点。已建立 TCP 会话无法在节点真正失效后无损迁移。
- Egern 默认规则经过“RayLink 代理”顶层选择组；system DNS 映射正确；策略切换不主动关闭既有连接。私网规则前置部分只匹配已有 IP，解析私网的补充规则在域名决策之后；IPv6 使用对应字段。
- Egern AI 默认 DNS 使用独立 Quad9 IP 端点，通过普通路由选择 AI 出口。此规则位于用户规则之后，用户对该地址的显式规则仍优先；Egern 的 proxy-DNS 内部解析仍有强制直连语义，不能保证所有内部解析都走 AI 隧道。

## 完整国内数据与更新

三端默认使用同一份经过校验的 SagerNet 数据：618 条精确域名、8232 条域名后缀、8 条正则、7774 条 IPv4/IPv6 CIDR。前导点后缀的“仅子域名”含义在跨客户端转换时保留。Mihomo 使用 inline providers，Egern 生成完整 DNS/路由规则，sing-box 可使用主控 SRS 或完整随包 inline JSON。

这些数据保留已有审核的固定上游提交，不声称是今天上游的最新分类。清单包含版本、来源、摘要、大小及数量；下载失败、校验失败、损坏缓存和离线应用升级都有完整基线或最近有效版本。两份数据按一代整体原子切换，固定摘要不会每天重复下载。

维护入口及许可证见 [规则集说明](../server/routing/rule-sets/README.md)。应用发布可更新所有格式的基线。可选 `RAYLINK_RULE_SET_MANIFEST` 只更新主控/使用远程 SRS 的 sing-box 活动规则；Mihomo/Egern 的 inline 数据随应用发布更新。管理页面分别显示这两个版本，避免把独立 SRS 更新误报成全部客户端同步。

## 诊断与可解释性

诊断现在遵从显式规则优先级，区分域名 DNS 策略与路由动作。结果明确标为规则推断或主控系统 DNS 推断。混合地址显示不确定结果、每地址判断和可用时的 sing-box 任一地址匹配预测；不冒充客户端实测。超过 16 个地址停止 IP 匹配、标注截断并取消最终预测，避免大量并发内核进程。

## 验证方式与结果

命令（本机隔离的 Darwin ARM64 1.14.2）：

```sh
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/sing-box npm run check
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/sing-box npm run check:protocols
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/sing-box npm run check:routing
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/sing-box npm run check:dns
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/raylink-sing-box \
  SING_BOX_CLIENT_BIN=/tmp/raylink-singbox-1.14.2/sing-box npm run check:traffic
npm run check:soak
```

- SOCKS 真请求验证未知国内域名直连、境外代理、未知私网直连、自定义代理不被国内 IP 覆盖、高优先级 IP 拦截；HTTP CONNECT 目标证明指定 DNS 的 IP 实际用于代理拨号。修复前未知国内请求返回 PROXY，修复后返回 DIRECT；IP 拦截与显式代理 DNS 也分别取得先失败后成功的证据。
- 自动选路模拟保留生成的策略组，仅替换远程传输为本地 HTTP 代理并把探测周期压缩为 1 秒。覆盖较快 QUIC 分类候选不进入 TCP 默认池、延迟反转时 AI 出口与持续流保持、主节点失效切备用、全部 TCP 失败不直连。把 AI 容差降至 50ms 的负对照确实失败。
- 17 类服务端、9 类导出客户端、4 类 Reality、8 类 ACME 配置通过官方内核检查。9 类真实协议各传输 245760 bytes，计量有效，禁用用户后新连接被拒绝。
- DNS 上游 100% 丢包时，过期缓存约 2ms 返回，无缓存 TCP DNS 约 5007ms 失败，上游恢复后自动刷新。UDP DNS 超时不等于所有应用都在 5 秒收到失败响应。
- 4000 请求内存测试通过：测量阶段堆内存变化 -77000 bytes，无新增活动句柄。
- Mihomo 三种模式原生配置检查通过，空目录无需下载 GeoSite/GeoIP 数据；split-DNS 正反对照通过。
- `node tests/mihomo-smart-routing-check.mjs` 使用原生 Mihomo、三组本地 DNS 及 SOCKS 请求验证完整规则：`a1.mzstatic.com`、`blog.csdn.net`、`www.alibaba` 使用国内 DNS 并直连；裸域 `alibaba` 和 `google.com` 使用远程 DNS 并代理；`chatgpt.com` 使用 AI DNS 和独立 AI 出口。错误绑定国内 DNS 的负对照确实失败。该脚本把 DNS 改为本地 fixtures 和 redir-host，仅验证分类/路由，不验证加密 DNS 物理传输链路。

完整回归执行了 282 项：首次 281 项通过，唯一失败是工作流统一入口后的旧文本断言；更新该断言并定向复测 1/1 通过。最终路由核心定向回归 38/38 通过，真实路由/切换模拟也在 TTL=0 修复后重新通过。没有把首次非零退出描述为一次全绿运行。PR/main 与 Release 两种工作流统一调用 `check:production`，其包含 `check:routing`，防止发布绕过路由模拟；Mihomo 原生检查需要额外安装对应可执行文件。

## Standards

最终独立复审无遗留可执行项。审查发现的离线升级忽略新随包规则、诊断无界并发、发布检查清单漂移已修复并复测。

## Spec

最终独立复审无遗留 P1/P2 阻断。审查发现的显式 DNS 未参与代理拨号、Egern DNS 基础设施越过用户规则、TTL=0 重复解析绕过 IP 规则已修复；审查者独立重跑真实 IP 优先级与 DNS 轮转测试通过。

## 保留的验收边界

没有 Egern 真机、运营商蜂窝、Wi-Fi/蜂窝切换、TUN 接管、IPv6-only/NAT64 或生产部署结果。Egern 完整 profile 约 1.84MB，需真机确认导入和匹配性能。Mihomo/Egern 的 IPv6 开关保持原策略；保留 IPv6 规则不等于完成 IPv6-only 验收。

当前实现属于规则分流与客户端原生健康选择，不宣称多目标质量评分、精确失败次数防抖或按手机业务体验自动学习。未知域名采用加密远程解析后做 IP 分类，没有启用未经业务验证的 DNS 响应竞速/过滤。混合国内、境外 IP 在 sing-box 仍是原生“任一地址命中”语义，诊断会提示差异。

官方依据：[固定 1.14.2 resolve](https://github.com/SagerNet/sing-box/blob/v1.14.2/docs/configuration/route/rule_action.md)、[URLTest](https://github.com/SagerNet/sing-box/blob/v1.14.2/protocol/group/urltest.go)、[Egern DNS](https://egernapp.com/docs/configuration/dns/)、[Egern 规则](https://egernapp.com/docs/configuration/rules/)。
