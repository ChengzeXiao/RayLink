# sing-box 1.14.2 升级与模拟验收

日期：2026-10-01。RayLink 源码版本：0.2.33（待发布）。变更基线：`3e0058f`。

## 目标与验收边界

落实用户要求的“版本更新和功能适配，之后进行模拟测试”：

1. 主控、远程 RayLink Node、安装器、构建器、发布元数据与 CI 统一采用审批计量版 **1.14.2**。
2. 保留现有用户、权益、协议、计量和升级失败回滚行为。允许 1.13 / 1.14 Host 混合运行，按 Host 实际上报版本编译配置。
3. 适配 1.14 证书提供器和 DNS 新字段；客户端明确提示最低版本。
4. 使用真实内核验证配置、用户传输、流量计数、禁用用户与 DNS 上游丢包恢复；模拟主控/Node 升级成功及失败回滚。
5. 不自动部署线上、不变更主从部署架构。新增上游 Snell、OpenVPN、OpenConnect、SSR 等入口/出站不在此次 UI 接入范围，现有支持的协议优先迁移。

## 已实现

- Runtime 默认 1.13.14 → **1.14.2**；RayLink 应用及缓存版本 → **0.2.33**。
- 构建工具 Go 1.24.7 → **1.26.8**。上游 1.14.2 的 `go.mod` 要求至少 Go 1.25.5，旧构建器不可继续使用。
- 更新固定源码模块 Sum、Go Linux 双架构 SHA-256、官方双架构 Cronet 依赖包 SHA-256。继续使用完整现有 build tags 和 `with_v2ray_api`；不以无计量能力的官方 binary 替代生产 Runtime。
- 1.14 Host 使用 `tls.certificate_provider: {type: "acme", ...}`。保留域名、邮箱与证书存储路径；1.13 / 版本未知 Host 使用兼容的 `tls.acme`。发布快照现在携带 `runtimeVersion`，确保此判断使用真实 Host 状态。
- sing-box 客户端使用 `store_dns` 替代 `store_rdrc`、DNS 超时 **5s**、缓存容量 **4096**、过期缓存宽限 **30s**；后台刷新，缩短网络暂时中断时已缓存域名的等待。30s 期间可能得到旧地址，是明确的可用性取舍，不是无限缓存。
- 新导出的 sing-box JSON 要求 **1.14+ 客户端**，管理端、用户中心和通用订阅入口均显示提示；Mihomo/Egern/Loon 格式不因本次内核升级而要求升级 sing-box。
- 保留前一阶段的 TCP 优先回退、UDP 协议健康准入、Shadowsocks TCP 能力标记、规则顺序和自动测速不打断现有连接策略。

## 复现方式

标准 Linux 发布 Runtime（含同目录 `libcronet.so`）：

```sh
sudo bash deploy/build-runtime-artifact.sh 1.14.2 /tmp/raylink-runtime
SING_BOX_BIN=/tmp/raylink-runtime/raylink-sing-box-1.14.2-linux-amd64 npm run check:production
```

ARM64 修改末尾架构为 `arm64`。脚本在原生 Linux 目标用户空间验证完整 tags，安装仍须遵循实际主控/Node 的服务管理方式。

macOS 隔离验收时使用自编译计量版作为服务端。Naive 客户端需要 Cronet，设置官方 CGO 客户端：

```sh
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/sing-box npm run check
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/sing-box npm run check:protocols
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/raylink-sing-box \
  SING_BOX_CLIENT_BIN=/tmp/raylink-singbox-1.14.2/sing-box npm run check:traffic
SING_BOX_BIN=/tmp/raylink-singbox-1.14.2/raylink-sing-box npm run check:dns
npm run check:soak
```

两个新模拟脚本已加入 `check:production` 和 Linux CI。所有临时凭据、证书、监听端口及子进程都限定于本地测试并在结束时清理。

## 已取得的证据

- 官方 Darwin ARM64 1.14.2 下载包 SHA-256 验证通过；Go module 的版本、源码 commit 和模块 Sum 验证通过。
- 本地 Go 1.26.8 编译 Darwin ARM64 计量版成功；相同 tags 的 Linux AMD64 / ARM64 交叉编译成功，ELF 架构核对通过。官方 Linux 两种架构包均校验通过并包含 `libcronet.so`。
- 17 种现有服务端配置通过 `sing-box check`；9 种实际导出的对外客户端协议、4 种 Reality 组合、8 种 ACME 组合及 9 种协议探针通过配置检查。原测试报告曾按输入配置列表计入未导出的本地 socks/http/mixed，现按实际生成的 outbound 报告数量。
- 9 种对外协议（Shadowsocks、VMess、VLESS、Trojan、AnyTLS、Hysteria、TUIC、Hysteria2、Naive）各传输 **245,760 bytes**，内容一致，用户上下行统计有效；禁用用户后使用新连接均被拒绝。服务端使用 RayLink 生成配置与真实计量版，计数通过项目现有 gRPC 读取器查询。
- DNS 上游 **100% 丢包**模拟：TTL 过期后的缓存约 **2ms** 返回；无缓存 TCP DNS 约 **5003ms** 关闭失败；上游恢复后自动刷新为新 IP。UDP DNS 上游超时可能表现为无响应，不能把 5s 内核超时描述成所有应用必定在 5s 内返回错误。
- 内存 soak：4000 次 API 请求，后 3000 次用于测量；本轮堆增长 -60,256 bytes、RSS 增长约 3.2MB、无新增活动句柄。
- 完整单测/API/安装升级/回滚回归 **250/250 通过**，无跳过；该轮 API 配置验证显式使用隔离的官方 1.14.2。双维度代码审查在最终验收后补齐。

## 发布与真实网络验收

1. 先发布含 1.14.2 Runtime/Cronet 校验文件的 0.2.33 产物；README 的 0.2.33 下载命令在 Release 创建前不可作为已上线地址使用。
2. 备份数据库、当前 Runtime、Cronet 和活动配置；先升级主控应用，再对一个低流量 Host 执行 Runtime 升级。升级时仍校验旧活动配置，失败走已有回滚；成功后下一次 Deployment 才迁移 ACME 格式。
3. 验证计量增长、用户禁用、证书续期、健康探针，再分批升级其他 Host。客户端先升级到 1.14+ 再重新导入 sing-box JSON。
4. 如要人工降回 1.13，必须连同兼容的旧配置恢复；不能拿已迁移的新证书配置直接运行旧内核。
5. 在真实手机测试 Wi-Fi → 蜂窝 → Wi-Fi 切换、IPv4/IPv6、UDP 限制、持续视频/长连接和至少 30 分钟稳定性；记录成功率、DNS/首包时延、吞吐和重连次数。

本轮未进行线上部署、Linux systemd 原生运行、真实 CA 颁发/续期、TUN 路由接管或手机运营商测试。本机 Docker 服务未运行；Linux 二进制交叉编译不是 Linux 原生验收，CI 的原生执行仍是发布门槛。弱网 DNS 模拟不是运营商吞吐提升的证据。

参考：[上游发布](https://github.com/SagerNet/sing-box/releases/tag/v1.14.2)、[固定版本迁移说明](https://github.com/SagerNet/sing-box/blob/v1.14.2/docs/migration.md)、[固定版本构建说明](https://github.com/SagerNet/sing-box/blob/v1.14.2/docs/installation/build-from-source.md)。
