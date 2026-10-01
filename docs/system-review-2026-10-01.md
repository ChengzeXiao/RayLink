# RayLink 系统审查与修复记录

## 范围与结论

基线：`6e0540d`，分支 `codex/user-save-mobile-routing`。本轮围绕用户与权益、计量、管理员权限、发布与恢复、Node 回执、DNS 资源控制、协议健康、智能分流证据和控制台操作进行并行审查，修复后分别进行 Standards / Spec 交叉复核。sing-box 保持已适配的 1.14.2。

本轮确认的问题均已修复并加入公开接口回归；交叉复核的剩余 P1/P2 为 0。这是本次检查范围内的结论，不等于整个项目没有其他缺陷。没有推送、发布版本或操作线上服务器。

## 已修复的问题

| 领域 | 可复现问题及影响 | 修复 | 核心回归 |
| --- | --- | --- | --- |
| 用户计量 P1 | 同 Host 重启后旧实例样本晚到，覆盖新水位并重复扣费 | 按 Host / 用户 / Runtime 实例保存水位，累计值单调取增量 | `store-usage-runtime.test.js` |
| 采样一致性 P2 | 本机和 Node 先读实例 ID、再查询计数，中途重启会错贴 epoch | 查询前后核对实例，不稳定采样拒绝计入，下一次累计补齐 | `usage-collector-consistency.test.js`、`node-agent.test.js` |
| 旧库迁移 P2 | 只保留最后一个实例的旧表遗漏其他水位；裁剪后的账本 SUM 也不能代表完整累计 | 事务迁移、完整历史回填；缺失或部分历史采取保守基线，保留可信旧水位 | `store-usage-runtime.test.js` 的真实清理与重开用例 |
| 管理权限 P1 | 两个 SQLite 连接同时降权最后两个 Owner，可导致无 Owner | 检查、更新、会话撤销在同一 `BEGIN IMMEDIATE` 事务内 | `store-admin-concurrency.test.js` 的双 Worker 竞态 |
| 任务顺序 P1 | 较旧任务失败重试或租约到期，可能在新发布成功后恢复旧配置/权限 | 领取和完成阶段均终结被替代任务，状态及副作用原子更新 | `store-task-ordering.test.js` |
| 发布顺序 P1 | 异步准备 TLS 候选前没有锁，较旧候选可能较晚发布 | 锁覆盖候选准备、应用、远端入队并在 finally 释放 | `deployment.test.js` |
| Node 回执 P1 | 执行成功但回执断网，被当作执行失败并重复重启 | 执行结果与投递分离，回执原子落盘，重启优先补报 | `node-agent.test.js` 跨 Node 对象重启用例 |
| 故障恢复 P1/P2 | 恢复旧服务失败被吞；首次发布失败删除配置后候选进程仍可能运行 | 原子恢复并保留恢复错误；无旧配置时停止候选并确认退出，不能确认则报失败 | `runtime-adapter.test.js`、`node-agent.test.js` |
| DNS 资源 P2 | 表面超时后底层查询继续，移动/上游黑洞时堆积 | 独立 Resolver、超时取消、隔离不同 Host 的查询 | `endpoint-resolver.test.js` 的真实 UDP DNS 黑洞与并行恢复 |
| 诊断 API P2 | 系统 DNS 挂起使 HTTP 请求无限等待 | 默认 2 秒返回 504，同域名合并、最多 4 个不同域名在途，满载返回 503 | `routing-diagnostics.test.js` |
| 自动选路 P2 | 数天前成功记录仍参与 UDP 智能推荐；null 抖动被当 0 | 15 分钟有效窗口、至少 3 轮近期样本、拒绝空质量指标 | `protocols.test.js` |
| 健康证据 P2 | 更改地址、端口、TLS 或传输后仍显示旧成功；在途检测可重新写回旧证据 | 数据变更原子失效，写回前核对配置指纹；未应用配置跳过检测 | `store-health-evidence.test.js`、`protocol-activation.test.js` |
| 运行状态 P2 | 远端 Node 心跳新鲜但 Runtime 停止时漏告警；缺失时延显示 0ms；暂存配置显示运行正常 | 服务状态独立判断，缺失/过期指标明确待确认，暂存不等于运行 | `alerts.test.js`、`protocol-health-ui.test.js` |
| 关闭流程 P2 | 初始化备份尚在异步 list/create，关闭数据库后仍继续备份 | 追踪整个自动备份操作，关停时等待结束再关闭 Store | `api.test.js` 的确定性异步关停回归 |

用户创建、修改权益、非法输入、订阅、禁用撤销、发布失败后的重试、角色权限及升级脚本继续由既有 API 与集成测试覆盖。

## 新功能

已实现 **系统 → 运行体检**：认证只读 API、明确证据时间、异常/待确认区分、修复入口、诊断报告导出、并发请求合并。最新发布失败不会被旧 active 掩盖；仅私有 SOCKS/HTTP/Mixed 不算可交付入口；最新备份执行现场文件哈希及 SQLite 完整性检查。

详细验收与下一步三项实用功能（流量对账、灰度发布与可靠恢复、客户端网络诊断）见 [实用功能设计](practical-features.md)。后三项仅设计，未声称已交付。

## 验证

最终 `npm run check` **326/326 通过，0 失败、0 跳过**，耗时约 259 秒。首轮 325/325 通过后，交叉复核发现部分账本迁移边界，补回归与修复后重新运行全量。

真实内核模拟均通过（Darwin ARM64、sing-box 1.14.2）：

- 17 个服务端协议配置、9 个客户端协议、4 种 Reality、8 种 ACME 配置及 9 个探测配置的内核校验。
- 9 种协议每种真实传输 245,760 字节，确认按用户计量与撤销后新连接失效。
- 智能分流与 IP 优先模式，国内/私网直连、境外/AI 代理、自定义规则优先，以及 DNS 轮换后仍拨号已检查的 IP。
- 普通与 AI 自动选择 TCP；延迟反转时 AI 出口与长连接保持；主入口失败后新连接走可用 TCP 备份；全部 TCP 失败时关闭连接，不回落 DIRECT/QUIC。
- DNS 上游 100% 丢包场景：缓存回复约 1ms，未缓存查询约 5,002ms 结束，恢复后返回正常结果。这是模拟计时，不是移动网络 SLA。
- 4,000 次请求稳定性模拟：预热后堆使用变化 -71,800 字节，活跃句柄增量 0；RSS 总增长约 23.4MB，后半程约 7.6MB。不等于 24/72 小时耐久测试。

界面验收在独立临时数据库、回环地址和 dry-run 模式完成：登录、体检首次读取、刷新、路由策略与备份处理入口、创建真实 SQLite 备份后体检变为通过。导出按钮显示成功，API 报告白名单与权限已自动验证；内置浏览器没有返回下载完成路径，Chrome 未提供，未把该提示当成浏览器文件落盘证明。

## 必须保留的边界

1. **移动网络**：没有在真实 4G/5G、IPv6-only/NAT64、Wi-Fi/蜂窝切换或 iOS Egern 实机验收。本次修正超时堆积、旧健康误导、恢复和分流策略，不宣称运营商网络吞吐已提高。
2. **旧计量数据**：无法核实的历史实例首个样本可能免计一段不确定增量，以避免重复收费；随后增量正常。历史已经多扣的总额没有自动回溯改写。升级前应保留完整数据库备份。
3. **故障原子性**：内存发布锁不覆盖多个控制面进程。Node 执行完成到回执落盘之间仍有断电窗口；本机应用与远端意图持久化之间也不是跨进程原子事务。可靠发布设计将解决这些边界，不宣称 exactly-once。
4. **原生系统调用**：系统 getaddrinfo 本身无法取消；HTTP 超时、合并和并发上限限制资源占用，后台调用仍由 OS 结束。
5. **自动选路**：UDP 健康时效决定智能推荐资格；显式 UDP 组仍保留。仅有 UDP 节点且全部无新鲜证据时，原有可用性兜底仍可能使用它们，不能称为彻底禁用过期节点。
6. **部署**：systemd 故障注入使用命令执行器模拟，没有在目标 Linux 主机重启真实服务；备份恢复演练、真实证书、滚动升级及长期运行仍需上线前验收。

## 复现命令

```sh
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/sing-box npm run check
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/sing-box npm run check:protocols
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/raylink-sing-box SING_BOX_CLIENT_BIN=/tmp/raylink-singbox-1.14.2/sing-box npm run check:traffic
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/sing-box npm run check:routing
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/sing-box npm run check:dns
npm run check:soak
```

上述临时内核路径是本次测试环境；其他机器应替换为经校验的 1.14.2 二进制。流量计量模拟要求服务端带 `with_v2ray_api`。
