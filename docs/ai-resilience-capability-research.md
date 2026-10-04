# 单 VPS AI 稳定策略：原生核心能力核实

查询日期：2026-10-04。本文是方案研究，不表示功能已部署，也未改变线上配置。官方网页是滚动文档；关键行为同时核对了 sing-box **v1.14.2** 与 Mihomo **v1.19.25** 固定版本源码。其他版本、手机应用封装和后台运行限制须另做验证。

## 原生订阅能够实现的部分

| 能力 | 核实结果及边界 |
| --- | --- |
| 同一主机、多协议候选 | 可以把 AI 选择范围限定为同一 Host 的授权协议。换协议主要改变客户端到 VPS 的传输；是否始终同一公网出口仍需核实服务器出站、NAT 和 IPv4/IPv6 选择，不能仅凭 Host ID 推断。 |
| Mihomo 按顺序回退 | `fallback` 默认寻找列表中第一个通过测试的代理；较早成员恢复后，新连接可能重新选它。因此它不是“用上备用后固定 10 分钟”的状态机。[官方说明](https://wiki.metacubex.one/en/config/proxy-groups/fallback/)、[v1.19.25 fallback 源码](https://github.com/MetaCubeX/mihomo/blob/v1.19.25/adapter/outboundgroup/fallback.go) |
| sing-box 自动选择 | URLTest 支持探测间隔、延迟容差和空闲停测。v1.14.2 先考虑当前成员，再比较候选与容差；这是延迟选择，不是严格优先级回退，也不是永久粘滞。[URLTest 文档](https://sing-box.sagernet.org/configuration/outbound/urltest/)、[v1.14.2 源码](https://github.com/SagerNet/sing-box/blob/v1.14.2/protocol/group/urltest.go) |
| 精确连续失败次数 | **`max-failed-times` 不能解释为连续 N 轮探测失败才切换。** Mihomo 文档和源码显示它在拨号失败累计达到阈值后触发强制健康检查；健康检查结果与 fallback 的选择是另一套逻辑。[字段说明](https://wiki.metacubex.one/en/config/proxy-groups/#max-failed-times)、[v1.19.25 GroupBase 源码](https://github.com/MetaCubeX/mihomo/blob/v1.19.25/adapter/outboundgroup/groupbase.go) |
| 完整健康检查 | Mihomo 的 group `url` 检查 `proxies` 成员，不替代 `use` 引用的 provider 检查；`lazy` 默认开启，未选中的组可能不测。应避免重复探测，也不能把“没有新结果”显示成正常。[字段说明](https://wiki.metacubex.one/en/config/proxy-groups/) |

建议：普通手机客户端先采用兼容的原生回退，界面准确写明“核心原生策略”；精确失败次数、恢复次数和冷却策略只在具备控制能力的客户端启用。此处是设计建议，不是已有原生字段。

## 严格智能策略需要客户端执行点

sing-box selector 当前通过 Clash API 控制；Mihomo API 提供当前选择、延迟历史、单代理测试和 `PUT /proxies/{name}` 选择。由此可以在**本机 Agent、受控客户端或实际承载流量的网关**实现“连续失败 N 次 → 切换同机候选 → 连续恢复 M 次 → 冷却后允许回归”，而服务端面板只发布策略和展示结果。[sing-box selector](https://sing-box.sagernet.org/configuration/outbound/selector/)、[Mihomo API](https://wiki.metacubex.one/en/api/)

注意：Mihomo 的整组 `/group/{name}/delay` 测试会清除自动组的固定选择，因此诊断按钮不能无条件调用它，否则可能扰乱粘滞策略；优先使用单代理探测或自行维护的 selector。[Mihomo API](https://wiki.metacubex.one/en/api/)

控制器应绑定本机回环地址并使用密钥，面板通过受控通道传递策略与汇总结果。能生成订阅、能访问服务器 MCP，不代表能访问每个手机内核的 controller；手机应用是否开放 API、是否允许后台常驻，需要能力协商。[Mihomo external-controller 与 secret](https://wiki.metacubex.one/en/config/general/#external-control-api)

试验参数以[统一方案](./ai-stability-unified-plan.md)为准：二十秒窗口至少两次失败并确认替代路径可用，五分钟回切冷却，至少三次恢复检查后重新列为候选。这只是待验证参数，不是可保证的切换 SLA。无客户端执行点时，不展示这些保证。

## 长连接保护能做什么

- sing-box 设置 `interrupt_exist_connections: false` 可避免选择变化时主动关闭外部入站连接；文档明确**内部连接仍会被打断**。它不能让已经故障的 TCP/TLS/SSE/WebSocket 连接迁移到另一协议，也不能保证上游网站不主动断开。[selector 文档](https://sing-box.sagernet.org/configuration/outbound/selector/)、[URLTest 文档](https://sing-box.sagernet.org/configuration/outbound/urltest/)
- Mihomo v1.19.25 的代理选择接口调用选择器并保存选择；没有在此接口里批量删除现有连接。新策略应只影响新建连接，不调用关闭全部连接或重启内核；应用封装是否额外断连仍需实际长连接测试。[固定版本接口源码](https://github.com/MetaCubeX/mihomo/blob/v1.19.25/hub/route/proxies.go)
- 连接建立超时、TCP keepalive 和业务响应等待应分开。sing-box 提供 `connect_timeout`、`tcp_keep_alive`、`tcp_keep_alive_interval`，不能把 5 秒健康检查超时套到持续输出的 AI 会话。[Dial Fields](https://sing-box.sagernet.org/configuration/shared/dial/)
- SSE 的应用心跳须由应用端实现；标准给出了注释心跳的做法，透传 TLS 隧道不能安全向加密流插入它。已中断的模型请求是否重试应由业务客户端处理，不能让网络层盲目重放 POST，避免重复任务和费用。[WHATWG SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html#authoring-notes)、[RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)

## 诊断证据必须标注来源

| 观察位置 | 能支持的判断 | 不能代替的证据 |
| --- | --- | --- |
| 服务器匿名探针 | VPS 到目标的 DNS、连接、TLS、匿名 HTTP 返回 | 手机到 VPS 是否通；真实账号、已登录网页或模型请求成功 |
| 客户端逐协议探针 | 当前设备、当前 Wi-Fi/移动网络，经具体协议到探测目标的结果 | 所有 AI 域名均可用、账号未受限、未来长连接不掉线 |
| 应用自愿上报的脱敏结果 | 某次真实请求的认证、限流、首字节和中断情况 | 未上报设备或其他账号的状态 |

HTTPS 应用数据受 TLS 加密保护。未终止该 TLS 会话的 RayLink/Clash 隧道不能从用户真实流量读取 API 的 401、403、429 或 SSE 内容；它只能看到有限连接元数据。主动匿名探针是自己发起的独立 TLS 客户端，所以可以读取**它自己的** HTTP 状态。这是基于 TLS 保密性质的架构推论。[RFC 8446 §5](https://www.rfc-editor.org/rfc/rfc8446.html#section-5)

因此“网站验证、认证、限流”只能来自独立探针或用户授权的应用结果，并明确显示来源、时间及是否认证。这些信号不应直接触发换协议或换出口：收到 401/429 不等于隧道坏了，403 也不能单独认定为封号、地区限制或 GFW。

## 给方案的约束

1. 采用“单一策略模型 + 各内核能力映射 + 独立证据记录”，不要把一份相同 YAML/JSON 参数宣称为跨客户端相同行为。
2. 传输探针驱动传输回退；匿名站点诊断用于解释；业务结果由应用端提供。不同层不得互相冒充。
3. 将“保护仍健康的现有连接”与“恢复已断开的请求”分开承诺。
4. 单 VPS 全 IP 不可达时，只能告警并保留允许直连的流量；同机多协议不构成跨主机容灾。
5. 验收必须包含真实客户端版本、Wi-Fi/移动网络、UDP 阻断、单端口故障、整 IP 不可达、恢复抖动和长流测试；服务器 HTTP 200 不能替代这些结果。
