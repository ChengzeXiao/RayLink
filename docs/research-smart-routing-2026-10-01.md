# 智能分流能力研究（2026-10-01）

范围：只读分析 RayLink `ec468a404ee94ff56aa268f7d2f82205bd8512ab`，未修改配置生成或部署。sing-box 结论核对本机 Go 模块缓存中 **v1.14.2** 的源码和随版本文档；Mihomo、Egern 为当日官方在线文档，尚未逐一确认客户端最低支持版本或真实手机行为。

## 1. 已确认的当前实现差异

### sing-box 的未知域名 GeoIP 分流并未覆盖所有入口

RayLink 生成器在 `server/singbox/protocol-catalog.js` 中生成 sniff、私网、自定义域名/IP、中国域名和 GeoIP 规则，但没有 `resolve` 动作。1.14.2 的 CIDR 匹配只检查 `Destination` 中已有的 IP 或 `DestinationAddresses`，不会自动发起 DNS；路由循环遇到 `resolve` 才补充目的地址。因此 SOCKS 域名请求未命中国域名集、尚无目的 IP 时，不能靠当前 GeoIP 规则实现所声明的 `unknownDomain: resolve-geoip`。TUN 已拿到真实 IP 的路径仍可以命中，不能说所有 GeoIP 规则均失效。本项为源码证据，尚未在本次研究新建端到端复现。

证据：[v1.14.2 CIDR matcher](https://github.com/SagerNet/sing-box/blob/v1.14.2/route/rule/rule_item_cidr.go)、[路由循环与 actionResolve](https://github.com/SagerNet/sing-box/blob/v1.14.2/route/route.go)。建议在域名显式策略之后、依赖 IP 的分类之前设计受控解析；自定义 IP 规则必须保留原有优先级语义，不能简单把全部 IP 规则挪到末尾。

### sing-box 智能组没有严格 TCP 优先，也不是综合质量评分

RayLink 把 TCP 节点和通过服务端健康门槛的 UDP 传输节点放入同一 `urltest`，默认 3 分钟，容差 80ms。列表顺序仅影响未获得有效历史等情形；有历史时内核按照延迟和容差选择，UDP 可以胜出。服务端健康数据也不能证明手机到节点的路径健康。

1.14.2 原生 URLTest 只有一个探测 URL、周期、延迟容差和空闲参数；不能往配置中虚构多目标探测、丢包权重或连续失败次数字段。接口更新会触发 URLTest 重新检测，这一点内核已有实现。

证据：[URLTest 配置](https://github.com/SagerNet/sing-box/blob/v1.14.2/docs/configuration/outbound/urltest.md)、[Select 和 InterfaceUpdated 实现](https://github.com/SagerNet/sing-box/blob/v1.14.2/protocol/group/urltest.go)。

### Egern 策略入口和 DNS 语义需要统一

RayLink Egern profile 的智能/全局默认规则直接引用“网络环境”，跳过“RayLink 代理”选择组；选择后者不会改变这些默认流量的出口。自定义 `dns: system` 当前被映射为 `domestic`，虽然已存在 `local: [system]` 上游。以上均由 `server/subscriptions/formats.js` 的生成分支直接确认。

Egern 官方文档明确默认 DNS 的上游连接遵从代理规则，而 `proxy_nameservers` 强制直连并跳过 Forward。因此不能仅凭 overseas 数组没有显式 detour 就断言 DNS 泄漏；必须区分解析路径并抓包验证。当前配置的强制 proxy DNS 上游是阿里 DoH，应核对代理目标解析与用户规则是否符合期望。[Egern DNS](https://egernapp.com/docs/configuration/dns/)

## 2. 1.14.2 可用于实现的能力与限制

- `evaluate` 获取响应但继续匹配；后续用 `match_response` 判断地址/响应码，`respond` 返回对应的已有响应。`race`、`speculative` 也确实存在于 **v1.14.2**，不是引用未来版本猜测。第一阶段可以先用串行有界超时，确认语义后再评估并发，避免每个域名都双发 DNS。[固定版本 DNS action 文档](https://github.com/SagerNet/sing-box/blob/v1.14.2/docs/configuration/dns/rule_action.md)
- 新 DNS 地址响应判断应使用 `evaluate` + `match_response`；不要继续使用旧式地址过滤。官方迁移示例先查 remote，响应命中国内 IP 后改用 local。[固定版本迁移示例](https://github.com/SagerNet/sing-box/blob/v1.14.2/docs/migration.md)
- **GeoIP 匹配是“任一地址命中”，不是“全部地址均为中国”。** 同一响应含中国和境外地址时，不能把 `geoip-cn` 命中描述成安全的全中国结论；`respond` 也不会自动删掉未命中地址。混合 CDN 响应要列入测试和产品策略。[CIDR matcher](https://github.com/SagerNet/sing-box/blob/v1.14.2/route/rule/rule_item_cidr.go)
- DNS 缓存的网络环境隔离只适用于实现 `DNSTransportWithEnvironment` 的传输。1.14.2 的 local、DHCP、mDNS 有该接口；不能保证所有固定远程 DoT 缓存都会按 Wi-Fi/蜂窝网络隔离。保留当前 30 秒过期缓存宽限可提高短故障可用性，但企业内网域名宜禁用过期缓存并测试网络切换。[缓存环境键](https://github.com/SagerNet/sing-box/blob/v1.14.2/dns/client.go)、[local resolver](https://github.com/SagerNet/sing-box/blob/v1.14.2/dns/transport/local/local.go)
- URLTest 的 `interrupt_exist_connections: false` 保护入站现有连接；官方明确内部连接仍可能被中断。不能将该设置宣传为换网、换出口时所有会话无损。[URLTest 文档](https://github.com/SagerNet/sing-box/blob/v1.14.2/docs/configuration/outbound/urltest.md)

## 3. 建议的智能分流架构

把“去哪条线路”和“选哪个节点”分开建模，再由同一策略生成各客户端的路由与 DNS。推荐策略顺序：本机/内网基础设施 → 按优先级的用户规则 → AI/明确境外服务 → 完整国内域名集 → 对未分类目标进行解析与 IP 判断 → 默认代理。对未知域名返回私网地址的处理需保留企业 split DNS 能力，同时考虑 DNS 污染，不能把所有公网域名返回私网地址都当作可信内网。

DNS 建议对应四种用途：系统/企业内网、国内直连、代理出口解析、节点启动解析。用户填写 `system` 必须保持系统解析含义；代理节点域名解析不能依赖尚未建立的代理；AI 专用出口的解析尽量与该出口一致。阻断域名可以在 DNS 阶段拒绝，以免无意义地向上游发起请求。域名规则命中后不再用较低优先级 GeoIP 改写它的动作。

未知域名有两种取舍，应明确产品默认值：

1. 保守模式：先用经稳定代理的可信加密 DNS 判断，再对国内目的地采用本地/国内解析。代价是未知国内网站首访可能依赖代理。
2. 低延迟模式：先用可信国内加密 DNS，响应符合国内分类再直连，否则使用代理 DNS。国内 IP 并不证明响应未被污染；明确境外/AI 规则必须先命中，并为异常、混合地址和超时保留代理兜底。

这是未来设计建议，并非现有实现保证。应通过回放实际域名分布后选择；不要以“国内 IP 必然安全”或“所有 DNS 永远最快”作为承诺。

移动网络建议先保证 TCP 传输候选池可用；UDP 传输健康应由设备当前网络的探测决定，服务器健康仅作为准入参考。**UDP 传输的隧道**与**隧道里承载的 UDP 业务**必须分别判断：例如 QUIC 隧道可以承载 TCP；TCP 隧道也可能通过协议支持承载 UDP。屏蔽所有 UDP 会误伤 DNS、语音等业务，而单独限制业务 QUIC/UDP 443 也不能证明隧道 QUIC 已禁用。[固定版本 UDP over TCP 说明](https://github.com/SagerNet/sing-box/blob/v1.14.2/docs/configuration/shared/udp-over-tcp.md)

AI 组建议单独持久化选择、同地域备用，减少出口变化；避免逐连接轮询。原生 URLTest 的容差可以降低抖动切换，但不能提供指定地域、业务可用性验证或严格会话粘性，这些需要 RayLink 候选元数据与客户端控制支持。单个 generate_204 成功不能证明 ChatGPT/Claude 可用，多业务探测需要新增控制逻辑或受支持客户端能力，不能伪装成 sing-box 原生字段。

## 4. 跨客户端边界

| 客户端 | 可利用能力 | 需要保留的限制 |
|---|---|---|
| sing-box 1.14.2 | 显式 DNS 响应判断、resolve、URLTest 容差、接口变更重测 | 没有通用 URLTest 多目标权重配置；不能直接照搬 Mihomo fallback 参数 |
| Mihomo | DNS nameserver-policy、respect-rules、proxy-server-nameserver；现有生成器已有相关配置 | respect-rules 需要独立节点解析防止循环；direct-nameserver 是否遵循 policy 有独立开关；对目标版本做真实解析测试 |
| Egern | conditional 网络环境、fallback、smart 综合评分 | smart 参数多由内核固定，仅暴露优先系数；不能承诺各平台采用同一评分算法；最低版本和手机换网待验 |

Mihomo 依据：[官方 DNS](https://wiki.metacubex.one/config/dns/)。Egern 官方 smart 描述包含延迟、抖动、可靠性、滞回和停留时间；fallback 按顺序选择并自动回切；conditional 支持 Wi-Fi/蜂窝匹配。这些能力适用于相应 Egern 版本，不能外推到 sing-box。[官方策略组](https://egernapp.com/docs/configuration/policy_groups/)

## 5. 下一轮应验证的行为

- 同一未知中国域名，经 TUN 实 IP、SOCKS 域名、HTTP CONNECT 三条路径，最终动作一致。
- 用户域名规则、IP 规则、AI 规则、国内规则重叠时，DNS 与路由遵守同一优先级；包括显式强制代理的中国 IP。
- DNS 正常、NXDOMAIN、空答复、混合中国/境外地址、私网答复、上游超时和污染；记录实际 DNS 出口与连接目的地。
- 阻断隧道 UDP 而保持 TCP 可用、只阻断业务 UDP 443、丢包/延迟突增；区分 HTTP 204 成功与真实业务可用。
- Wi-Fi → 蜂窝 → Wi-Fi 后，节点重测、split DNS 缓存、持久化选择、AI 长流会话分别验收。
- Egern 手选“RayLink 代理”能改变默认流量，`system` DNS 命中系统解析；实际应用版本的 DNS 上游连接抓包确认。
- 规则集更新有版本、校验、最后成功时间、失败回滚和过期提示；不能只看客户端每日下载就断言数据每日更新。

本次未运行以上新模拟，未更改在线节点，也未据此宣称手机网络问题已解决。
