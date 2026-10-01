# RayLink 生产化统一规划

## 目标

RayLink v0.2.26 继续定位为生产候选版本。正式商用版本必须让控制面、每个 RayLink Node、sing-box Runtime、用户权益和三种订阅导出保持同一事实来源，并且在失败时可检测、可回滚、可审计。

## 统一系统模型

### 配置发布

一次发布由一个不可变 Deployment 和多个 Deployment Target 组成：

- `local` Target：控制面本机 Runtime。
- 每台远程 Host 一个 Target：由 RayLink Node 原子领取、校验和应用。
- Target 状态统一为 `pending → deploying → applied`，失败进入 `failed`。
- Deployment 只有所有 Target 都为 `applied` 时，`rolloutStatus` 才是 `complete`。
- 用户撤权、配额耗尽和节点范围缩小时使用关键任务，不因普通重试次数耗尽而失效。

### 路由策略

`server/routing/policy.js` 管理路由模式、自定义规则和候选组，`server/routing/rule-sets/` 提供经过校验的完整国内基线。Mihomo、Egern 和 sing-box 按原生能力生成配置。当前语义如下：

| 策略 | 语义 |
| --- | --- |
| RayLink 代理 | 用户默认入口 |
| AI 网站代理 | 独立稳定候选，支持固定具体出口，DNS 分路径适配 |
| RayLink 智能 | TCP 节点加上已证明稳定的 UDP 节点 |
| TCP 稳定 | VLESS、Trojan、AnyTLS、VMess、Shadowsocks 等 TCP 节点 |
| UDP 高速 | Hysteria、Hysteria 2、TUIC 等 UDP 节点 |
| 故障回退 | Mihomo/Egern 有序 TCP 优先回退；sing-box 默认使用 TCP URLTest，UDP 保留手选 |
| 手动选择 | 暴露全部可用节点供用户选择 |
| DIRECT | 中国域名、IP、局域网、私网与链路本地地址直连 |

统一策略还负责：

- AI 域名集合；
- 同源完整中国域名及 IP 基线；
- 策略候选节点；
- 健康探测地址；
- TCP/UDP 稳定性准入。

原生 fallback、URLTest 与 DNS 内部路径并非完全等价；实现、版本更新范围与实测边界见 [智能分流验收](smart-routing-implementation.md)。

### 协议健康

每轮执行 5 次真实协议连接，至少 4 次成功才判定本轮可用：

- P50 作为“连接耗时”；
- P95 体现尾部延迟；
- MAD 作为抗异常值抖动；
- 保存最近 12 轮窗口；
- 连续 3 轮失败才判定不可用；
- UDP 只有至少 3 轮且窗口成功率不低于 95%、抖动不高于 80 ms，才进入智能组；
- 服务端数据只叫“服务连通耗时”，客户端仍应按用户真实网络执行最终选路。

## 生产化里程碑

### P0：配置正确性与撤权安全

- [x] 多 Host 发布时比较完整 Host 快照，避免只比较本机 checksum。
- [x] 远程节点范围缩小时自动生成撤权发布。
- [x] Node 任务使用 SQLite 原子领取，避免多进程重复执行。
- [x] Deployment 返回每个 Target 的发布状态。
- [x] sing-box、Mihomo、Egern 共用路由组、AI 域名和探测地址。
- [x] 5 次采样、P50/P95、滚动成功率和连续失败判定。
- [x] 将 Target 状态和失败原因展示到总览及运维页面。
- [x] 增加双控制面进程原子领任务、关键撤权和节点恢复测试。

### P1：权限、备份与告警

- [x] 管理员角色：Owner、Operator、Support、Auditor。
- [x] 权限边界：系统配置、发布、用户、订阅重置、只读审计分离。
- [x] 对用户权益、订阅重置、主机、协议和发布等成功写操作记录审计事件。
- [x] SQLite 在线备份，保留 SHA-256、版本元数据并执行完整性校验。
- [x] 定时备份和保留策略。
- [x] 增加带校验、恢复点和失败回滚的停机恢复命令。
- [ ] 在干净 VPS 定期执行真实恢复演练。
- [x] 告警状态：节点离线、发布失败、协议连续失败、计量中断、备份过期和内存异常。
- [x] 增加远程节点已分发 TLS 证书临期与所有节点磁盘空间告警。
- [x] HTTPS Webhook 告警打开、去重和恢复通知。

### P2：发布工程

- [x] Linux amd64/arm64 原生构建矩阵。
- [x] Node.js 22/24 的 GitHub Actions 生产检查矩阵。
- [ ] 安装、初始化、升级、回滚和卸载矩阵。
- [x] 升级前数据库兼容检查和自动备份。
- [ ] 24 小时基础 soak、72 小时发布候选 soak。
- [x] 发布包 SHA-256、机器可读清单、SPDX SBOM、变更日志和 GitHub 构建来源证明。
- [ ] 干净 VPS 的端到端验收：安装到客户端成功访问目标网站。

## 正式商用门槛

所有条件必须同时满足：

1. 全量单元、API、协议、安装、升级和内存测试通过。
2. 两台以上 Host 的发布、回滚和撤权在节点离线后仍能最终一致。
3. 三种订阅的策略契约测试通过，同一账号切换客户端时默认路由行为一致。
4. UDP 失败不会拖垮默认选择，TCP 回退可用。
5. 角色越权测试、会话撤销、订阅密钥轮换和审计查询通过。
6. 自动备份连续成功，随机抽取的备份可恢复并通过数据库完整性检查。
7. 关键告警能够发送、去重、恢复和留痕。
8. 72 小时 soak 无持续内存增长、句柄泄漏、任务堆积或 SQLite 锁死。
