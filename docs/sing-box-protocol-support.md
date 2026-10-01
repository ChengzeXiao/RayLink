# sing-box v1.13.14 协议与安装能力研究

> 历史研究记录。当前 v0.2.33 / 1.14.2 适配与验收见 [升级记录](sing-box-1.14.2-upgrade.md)。

> 研究日期：2026-07-26
>
> 研究范围：只采用 sing-box 官方 GitHub 仓库、官方文档与官方安装脚本。
>
> 版本基线：官方 GitHub `latest` 稳定版为 **v1.13.14**（2026-06-25 发布）。界面配置模型必须绑定已安装版本，不能直接照搬可能包含下一版本字段的在线文档。[官方发布页](https://github.com/SagerNet/sing-box/releases/tag/v1.13.14)

## 结论

sing-box v1.13.14 的稳定版核心实际注册了：

- **17 种 inbound 类型**：10 种远程接入协议、3 种本地代理入口、4 种系统/透明代理入口。
- **18 种 outbound 类型**：14 种网络/上游出站与 4 种路由控制出站。
- **2 种 endpoint**：WireGuard、Tailscale。WireGuard 已不再是 outbound。
- VMess、Trojan、VLESS 可组合 HTTP、WebSocket、QUIC、gRPC、HTTPUpgrade 传输。
- Reality 不是独立协议类型，而是共享 TLS 配置的一种模式，且要求构建包含 `with_utls`。

以上集合以 v1.13.14 的注册代码为准；官方文档索引中仍可能出现已删除的 `wireguard`/`dns` outbound，或出现面向后续版本的条目，不能据此直接生成配置。[Inbound/Outbound 注册源码](https://github.com/SagerNet/sing-box/blob/v1.13.14/include/registry.go)

## Inbound 协议矩阵

所有网络监听型 inbound 都共享 `type`、`tag` 与 Listen Fields，例如 `listen`、`listen_port`、`bind_interface`、`tcp_fast_open`、`udp_timeout` 等。[配置总结构](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/index.md) · [Listen Fields](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/shared/listen.md)

### 远程接入协议

| 类型 | 关键配置结构（非完整字段清单） | 构建/组合约束 | 官方来源 |
|---|---|---|---|
| `shadowsocks` | `network`、`method`、`password`；多用户模式使用 `users`；可选 `multiplex` | UI 必须根据 method 切换单密码/多用户字段，不应把 SS2022 多用户密码拼装规则混入旧加密法表单 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/shadowsocks.md) |
| `vmess` | `users[{name,uuid,alterId}]`、`tls`、`transport`、`multiplex` | 支持 V2Ray Transport | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/vmess.md) |
| `trojan` | `users[{name,password}]`、`tls`、`fallback`、`fallback_for_alpn`、`transport`、`multiplex` | 通常要求 TLS；支持 V2Ray Transport | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/trojan.md) |
| `naive` | `network`、`users[{username,password}]`、`quic_congestion_control`、`tls` | TCP/HTTP2 可用；QUIC/HTTP3 部分要求 `with_quic` | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/naive.md) · [无 QUIC 构建的降级源码](https://github.com/SagerNet/sing-box/blob/v1.13.14/include/quic_stub.go) |
| `hysteria` | `up/down` 或 `up_mbps/down_mbps`、`obfs`、`users[].auth/auth_str`、接收窗口、`tls` | 要求 `with_quic` | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/hysteria.md) · [QUIC 注册源码](https://github.com/SagerNet/sing-box/blob/v1.13.14/include/quic.go) |
| `shadowtls` | `version`、`password` 或 `users`、`handshake`、`handshake_for_server_name`、`strict_mode`、`wildcard_sni` | ShadowTLS 本身是包装层；界面应提示其下游/握手配置关系 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/shadowtls.md) |
| `tuic` | `users[{uuid,password}]`、`congestion_control`、`auth_timeout`、`zero_rtt_handshake`、`heartbeat`、`tls` | 要求 `with_quic` | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/tuic.md) · [QUIC 注册源码](https://github.com/SagerNet/sing-box/blob/v1.13.14/include/quic.go) |
| `hysteria2` | `up_mbps/down_mbps`、`obfs{type,password}`、`users[{name,password}]`、`ignore_client_bandwidth`、`tls`、`masquerade` | 要求 `with_quic` | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/hysteria2.md) · [QUIC 注册源码](https://github.com/SagerNet/sing-box/blob/v1.13.14/include/quic.go) |
| `vless` | `users[{name,uuid,flow}]`、`tls`、`transport`、`multiplex` | `flow` 与传输/TLS 组合应做条件校验；Reality 配置位于 `tls.reality` | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/vless.md) · [TLS/Reality](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/shared/tls.md) |
| `anytls` | `users[{name,password}]`、`padding_scheme`、`tls` | TLS 为核心配置 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/anytls.md) |

### 本地代理与系统入口

| 类型 | 用途与关键字段 | 平台限制 | 官方来源 |
|---|---|---|---|
| `mixed` | 同端口提供 SOCKS/HTTP；`users`、`set_system_proxy` | `set_system_proxy` 由运行平台能力决定 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/mixed.md) |
| `socks` | SOCKS 入口；`users` | 无额外协议构建标签 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/socks.md) |
| `http` | HTTP 代理入口；`tls`、`users`、`set_system_proxy` | 无额外协议构建标签 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/http.md) |
| `direct` | 将入站直接交给目标；`network`、`override_address`、`override_port` | 属于接入/路由工具，不是用户订阅协议 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/direct.md) |
| `tun` | `interface_name`、`address`、`mtu`、`auto_route`、`auto_redirect`、`strict_route`、route include/exclude、`stack` | 仅 Linux、Windows、macOS；大量自动路由/UID/接口字段进一步限定为 Linux，UI 必须按 OS 隐藏 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/tun.md) |
| `redirect` | Listen Fields | 仅 Linux、macOS | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/redirect.md) |
| `tproxy` | Listen Fields、`network` | 仅 Linux | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/inbound/tproxy.md) |

## Outbound 协议矩阵

大多数远程 outbound 共享 Dial Fields，例如 `detour`、绑定接口、连接策略、TCP/UDP 选项等。[Dial Fields](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/shared/dial.md)

### 上游/网络出站

| 类型 | 关键配置结构（非完整字段清单） | 构建/组合约束 | 官方来源 |
|---|---|---|---|
| `socks` | `server`、`server_port`、`version`、`username`、`password`、`network`、`udp_over_tcp` | 版本和认证字段联动 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/socks.md) |
| `http` | `server`、`server_port`、`username`、`password`、`path`、`headers`、`tls` | HTTPS 由 `tls` 决定 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/http.md) |
| `shadowsocks` | `server`、`server_port`、`method`、`password`、`plugin`、`network`、`udp_over_tcp`、`multiplex` | method 决定密码格式 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/shadowsocks.md) |
| `vmess` | `server`、`server_port`、`uuid`、`security`、`alter_id`、`tls`、`packet_encoding`、`transport`、`multiplex` | 支持 V2Ray Transport | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/vmess.md) |
| `trojan` | `server`、`server_port`、`password`、`network`、`tls`、`transport`、`multiplex` | 支持 V2Ray Transport | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/trojan.md) |
| `naive` | `server`、`server_port`、`username`、`password`、`udp_over_tcp`、`quic`、`quic_congestion_control`、`tls` | 要求 `with_naive_outbound`，且有平台/动态库限制 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/naive.md) · [构建开关源码](https://github.com/SagerNet/sing-box/blob/v1.13.14/include/naive_outbound_stub.go) |
| `hysteria` | `server/server_port` 或端口跳跃、带宽、`obfs`、认证、窗口、`tls` | 要求 `with_quic` | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/hysteria.md) |
| `shadowtls` | `server`、`server_port`、`version`、`password`、`tls` | 通常作为 detour/包装组合使用 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/shadowtls.md) |
| `tuic` | `server`、`server_port`、`uuid`、`password`、`congestion_control`、`udp_relay_mode`、`tls` | 要求 `with_quic` | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/tuic.md) |
| `hysteria2` | `server/server_port` 或端口跳跃、带宽、`obfs`、`password`、`tls` | 要求 `with_quic` | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/hysteria2.md) |
| `vless` | `server`、`server_port`、`uuid`、`flow`、`tls`、`packet_encoding`、`transport`、`multiplex` | Reality 位于 `tls.reality` | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/vless.md) |
| `anytls` | `server`、`server_port`、`password`、idle session 参数、`tls` | TLS 为核心配置 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/anytls.md) |
| `tor` | `executable_path`、`extra_args`、`data_directory`、`torrc` | 默认调用外部 Tor；嵌入式 Tor 需 `with_embedded_tor` 和 CGO | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/tor.md) · [构建文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/installation/build-from-source.md) |
| `ssh` | `server`、`server_port`、`user`、密码或私钥、host key、`client_version` | 私钥、密码、host key 应作为 secret 管理 | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/ssh.md) |

### 路由控制出站

| 类型 | 关键字段/作用 | 官方来源 |
|---|---|---|
| `direct` | 直接连接；`override_address`、`override_port` 和 Dial Fields | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/direct.md) |
| `block` | 阻断连接；无协议参数 | [注册源码](https://github.com/SagerNet/sing-box/blob/v1.13.14/include/registry.go) |
| `selector` | 手动选择一组 `outbounds`；`default`、`interrupt_exist_connections` | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/selector.md) |
| `urltest` | 对一组 `outbounds` 自动测速；`url`、`interval`、`tolerance`、`idle_timeout` | [配置文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/urltest.md) |

## Endpoint

v1.13.14 把三层网络能力放入顶层 `endpoints`，不应继续在 outbound 表单中生成 WireGuard：

| 类型 | 关键字段 | 构建约束 | 官方来源 |
|---|---|---|---|
| `wireguard` | `system`、`name`、`mtu`、`address`、`private_key`、`peers[]`、`udp_timeout` | 要求 `with_wireguard`；旧 `wireguard` outbound 已在 1.13.0 删除 | [Endpoint 配置](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/endpoint/wireguard.md) · [注册/旧类型错误源码](https://github.com/SagerNet/sing-box/blob/v1.13.14/include/registry.go) |
| `tailscale` | state、auth key、control URL、hostname、route/exit node、system interface 等 | 要求 `with_tailscale` | [Endpoint 配置](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/endpoint/tailscale.md) · [构建降级源码](https://github.com/SagerNet/sing-box/blob/v1.13.14/include/tailscale_stub.go) |

`dns` outbound 也已由规则动作替代并在 1.13.0 移除。RayLink 不应为 `wireguard` 或 `dns` 创建 legacy outbound 表单。[WireGuard 迁移提示](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/wireguard.md) · [DNS outbound 迁移提示](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/dns.md)

## TLS、Reality 与 V2Ray Transport

### TLS/Reality

TLS 是多个 inbound/outbound 的嵌套对象，主要字段包括：

- 通用：`enabled`、`server_name`、`alpn`、TLS 版本、证书或证书路径。
- 服务端：证书/私钥、客户端证书认证、ACME。
- 客户端：证书校验、uTLS、ECH。
- Reality 服务端：`handshake`、`private_key`、`short_id`、`max_time_difference`。
- Reality 客户端：`public_key`、`short_id`。

Reality 依赖 `with_utls`；缺少该标签的源码会直接返回 “rebuild with -tags with_utls”。因此界面不能只根据协议名显示 Reality，必须读取已安装二进制的 build tags。[TLS/Reality 配置](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/shared/tls.md) · [uTLS/Reality 构建降级源码](https://github.com/SagerNet/sing-box/blob/v1.13.14/common/tls/utls_stub.go)

### V2Ray Transport

VMess、Trojan、VLESS 的 `transport` 可选：

| `type` | 关键字段 | 限制 | 官方来源 |
|---|---|---|---|
| `http` | `host[]`、`path`、`method`、`headers`、idle/ping timeout | 无 TLS 时为明文 HTTP/1.1 | [V2Ray Transport](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/shared/v2ray-transport.md) |
| `ws` | `path`、`headers`、early data | client/server 路径规则需一致 | [V2Ray Transport](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/shared/v2ray-transport.md) |
| `quic` | 无额外字段 | 要求 `with_quic` | [V2Ray Transport](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/shared/v2ray-transport.md) |
| `grpc` | `service_name`、idle/ping timeout、`permit_without_stream` | 标准 gRPC 需可选 `with_grpc`；默认实现不等于标准 gRPC 构建 | [V2Ray Transport](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/shared/v2ray-transport.md) |
| `httpupgrade` | `host`、`path`、`headers` | 路径必须按文档匹配 | [V2Ray Transport](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/shared/v2ray-transport.md) |

官方明确说明不提供独立的 TCP、mKCP、DomainSocket V2Ray transport；TCP 是协议默认承载，不应在 UI 中伪造 `transport.type = "tcp"`。[V2Ray Transport 差异说明](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/shared/v2ray-transport.md)

## 构建标签与平台限制

官方默认标签包含 `with_gvisor`、`with_quic`、`with_dhcp`、`with_wireguard`、`with_utls`、`with_acme`、`with_clash_api`、`with_tailscale` 等；但不同平台/发行渠道可能修改标签，官方文档也特别警告 Homebrew 等下游包可能修改默认标签。[默认标签文件](https://github.com/SagerNet/sing-box/blob/v1.13.14/release/DEFAULT_BUILD_TAGS) · [其他平台标签文件](https://github.com/SagerNet/sing-box/blob/v1.13.14/release/DEFAULT_BUILD_TAGS_OTHERS) · [构建说明](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/installation/build-from-source.md) · [包管理器警告](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/installation/package-manager.md)

RayLink 应在安装后执行：

```bash
sing-box version
```

该命令输出版本、GOOS/GOARCH、Tags、CGO。界面能力应由 `version + platform + tags` 三者决定，不能把构建期缺失的协议显示为“可发布”。[version 命令源码](https://github.com/SagerNet/sing-box/blob/v1.13.14/cmd/sing-box/cmd_version.go)

关键能力门禁：

| 能力 | 必需条件 |
|---|---|
| Hysteria、TUIC、Hysteria2 inbound/outbound；QUIC transport | `with_quic` |
| Reality client/server | `with_utls` |
| Naive outbound | `with_naive_outbound`，并满足 Cronet 平台/动态库条件 |
| WireGuard endpoint | `with_wireguard` |
| Tailscale endpoint | `with_tailscale` |
| ACME 自动证书 | `with_acme` |
| TUN gVisor stack | `with_gvisor` |
| TProxy | Linux |
| Redirect | Linux/macOS |
| TUN | Linux/Windows/macOS；具体路由、UID、接口字段再按 OS 限制 |

Naive outbound 的官方构建在 Linux purego amd64/arm64 依赖 `libcronet.so`，Windows purego 依赖 `libcronet.dll`；其他 Linux 架构可能使用 glibc/musl 变体，glibc 构建还有最低版本要求。[Naive outbound 平台表](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/outbound/naive.md)

## 官方安装方式

### Linux

官方提供三条可用于“一键安装”的路径：

1. Debian/Ubuntu：添加官方 APT 仓库后 `apt-get install sing-box`。
2. Red Hat 系：添加官方 repo 后 `dnf install sing-box`。
3. 官方通用脚本：

   ```bash
   # RayLink Linux 正式版不执行远程安装脚本，而是构建审批清单中的固定源码版本。
   ```

   可增加 `--version <version>` 固定版本。脚本识别 pacman、dpkg、dnf/rpm、apk、opkg，从官方 GitHub Releases 下载对应 deb/rpm/pkg/apk/ipk 再交给系统包管理器安装。支持 systemd 的 Linux 包通常包含 `sing-box` 服务。[官方安装文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/installation/package-manager.md) · [官方安装脚本源码](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/installation/tools/install.sh)

### macOS

官方文档给出的 CLI 安装方式是：

```bash
brew install sing-box
```

官方 `install.sh` 不处理 macOS；RayLink 在 Darwin 上必须走 Homebrew（或只检测已有二进制），不能调用 Linux 安装脚本。[官方 macOS 安装表](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/installation/package-manager.md) · [安装脚本平台判断](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/installation/tools/install.sh)

## RayLink 界面与后端落地要求

### 1. 安装中心

界面状态至少应有：`未安装`、`安装中`、`已安装`、`升级可用`、`安装失败`、`能力不完整`。

后端流程：

1. 检测 `sing-box` 路径并执行 `sing-box version`。
2. Linux 选择官方仓库/官方脚本，macOS 选择 Homebrew。
3. 安装命令只能来自后端白名单，不接受前端提交任意 shell。
4. 安装完成后再次探测版本、平台、架构、build tags。
5. 将能力矩阵返回前端，用来启停协议表单。

这是根据官方安装脚本的平台分支和 `version` 输出作出的实现建议。[安装脚本](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/installation/tools/install.sh) · [version 命令](https://github.com/SagerNet/sing-box/blob/v1.13.14/cmd/sing-box/cmd_version.go)

### 2. 配置中心

配置数据应拆成：

- 基础：日志、DNS、NTP。
- 入站：按上述 inbound schema 创建多个实例。
- 出站：按上述 outbound schema 创建多个实例。
- Endpoint：WireGuard/Tailscale。
- TLS/证书：证书文件、ACME、Reality。
- 传输：HTTP/WS/QUIC/gRPC/HTTPUpgrade。
- 路由：规则、规则集、默认出站。
- 高级：完整 JSON 预览与只读 diff。

JSON 顶层结构以官方 `log`、`dns`、`ntp`、`endpoints`、`inbounds`、`outbounds`、`route` 等字段为准。[官方配置结构](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/index.md)

### 3. 发布闭环

任何界面配置都必须经过：

1. 根据版本化 schema 生成候选 JSON。
2. 写入临时候选文件。
3. 执行 `sing-box check -c <candidate>`。
4. 检查成功后原子替换正式配置。
5. 重启或热切换进程，检查进程状态与日志。
6. 失败时恢复上一版配置。

`sing-box check` 是官方提供的配置校验命令。[配置检查文档](https://github.com/SagerNet/sing-box/blob/v1.13.14/docs/configuration/index.md) · [check 命令源码](https://github.com/SagerNet/sing-box/blob/v1.13.14/cmd/sing-box/cmd_check.go)

### 4. 版本化 schema

每个协议表单需要声明：

```json
{
  "type": "hysteria2",
  "direction": "inbound",
  "since": "1.8.0",
  "requiredTags": ["with_quic"],
  "platforms": ["linux", "darwin", "windows"],
  "fields": [],
  "secretFields": ["users.*.password", "tls.key"]
}
```

前端只负责编辑 schema；后端负责再次验证版本、构建标签、平台和交叉字段，避免绕过 UI 发布不受支持的配置。由于 v1.13.14 的官方源码会为缺失 QUIC、uTLS、Naive outbound 等能力注册明确的错误 stub，这一层后端校验是必要条件。[QUIC stub](https://github.com/SagerNet/sing-box/blob/v1.13.14/include/quic_stub.go) · [Reality stub](https://github.com/SagerNet/sing-box/blob/v1.13.14/common/tls/utls_stub.go) · [Naive outbound stub](https://github.com/SagerNet/sing-box/blob/v1.13.14/include/naive_outbound_stub.go)

## 建议的 RayLink 第一阶段支持范围

为了做到“安装后即可在界面完成配置”，第一阶段可以完整交付：

- 服务器入站：Shadowsocks、VLESS（含 TLS/Reality）、Trojan、Hysteria2、TUIC、AnyTLS。
- 本地入口：Mixed、SOCKS、HTTP。
- 基础出站：Direct、Block、SOCKS、HTTP、Shadowsocks，以及 Selector/URLTest。
- 公共能力：TLS/证书、Reality、HTTP/WS/gRPC/HTTPUpgrade/QUIC transport、路由、配置校验、发布、回滚。

其余已由内核支持的类型仍应出现在能力目录中，但标记为“高级/后续表单”，不要用自由 JSON 冒充完整图形化支持。最终“支持”应区分三层：

1. **内核支持**：安装的 sing-box 二进制具备该类型/标签。
2. **RayLink 可编辑**：有版本化表单与后端 schema。
3. **RayLink 可发布**：通过平台、标签、证书、端口冲突和 `sing-box check` 校验。

这样可以避免把“sing-box 源码有实现”错误等同于“当前机器可用”或“RayLink 已安全配置”。
