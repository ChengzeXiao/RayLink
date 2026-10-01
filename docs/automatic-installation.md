# 自动安装与维护

本功能从 v0.2.33 起提供，已有安装需升级后生效。当前支持 Debian/Ubuntu、Linux systemd、AMD64/ARM64；本机 macOS 的 `npm run local` 为开发模式，不能配置 Linux BBR 或运行 Linux systemd 服务。

## 首台主控

安装器自动补齐依赖、安装经过校验的 Node.js 与 sing-box 1.14.2 计量版、配置 Caddy 和 systemd，再执行首次初始化：创建随机管理员、设置本机 Host、启用无需域名证书的 Shadowsocks、配置 BBR、发布并检查服务与监听。登录信息只保存在服务器 `/etc/raylink/initial-login.json`，权限为 0600。重复初始化不会重置已有管理员。

已有但未配置的 Linux 主控，可在「系统 → 主机」执行“自动安装并配置”。步骤、失败原因和重试状态持久保存；二进制已下载不等于服务已运行。流程保留已有 Shadowsocks 密钥与端口。BBR 不支持时列为待处理项，其余服务继续安装。

默认使用 IP HTTPS。SSH 自动接入将主控证书经已核验的 SSH 连接传到节点，节点持久保存信任并校验证书和服务器地址。GitHub、Node.js 等公共源仍使用系统信任链，不使用主控 CA。浏览器、MCP 和订阅客户端需要自行信任 IP 证书。

域名已有正确 DNS 解析时，将 `RAYLINK_DOMAIN=panel.example.com` 和 `RAYLINK_ACME_EMAIL=ops@example.com` 传给安装器，即自动配置 Caddy 可信 HTTPS 和续期；它们不提供域名注册或任意 DNS 供应商权限。设置 `RAYLINK_INTERACTIVE_SETUP=true` 可使用向导分别配置控制台、订阅和节点域名。

## 新增节点

在「系统 → 主机」填写真实 IP、SSH 端口、用户名及密码或私钥。流程依次检查身份与权限、安装依赖/Node/Runtime、注册、配置 BBR 与默认 Shadowsocks、按已保存的 DNS 设置配置域名及兼容协议、发布、验证运行/计量/公网协议和已有用户订阅。

没有有效用户时订阅验证明确显示 `awaiting-users`。云安全组必须允许协议端口；SSH 凭据不能替代云厂商账户权限。失败保留 Host 与安装状态，可按同一任务续接。

## BBR 状态

界面展示每台主机实际上报的拥塞控制、队列算法、采样时间和原因。只有读数为 `bbr` + `fq`、节点在线且样本新鲜时才显示当前已启用。缺失或超过 60 秒的样本、离线、不支持、配置失败分别展示。远程重试返回任务已提交，等待回执和新心跳，不提前显示成功。

BBR 是 TCP 拥塞控制，不代表 UDP/QUIC 加速，也不保证某个移动运营商的速度。实际收益需要在目标 VPS 和客户端网络测量。内核参数见 [Linux 官方文档](https://docs.kernel.org/networking/ip-sysctl.html)。

## 更新

- 控制面：Owner 检查 GitHub 正式 Release，确认架构安装包和 SHA-256 文件完整后提交更新。独立 systemd 任务执行原有备份、迁移检查、切换和回滚流程；重启后验证实际版本及服务。更新中阻止并发 Runtime 修改。
- RayLink Node：0.9.0 起支持页面/MCP 提交程序更新。旧版需先执行一次升级命令。更新保留 Node 身份、CA、Runtime/Cronet 和配置，任务跨重启保存，失败可查看原因并重试。
- sing-box：沿用独立的 Runtime 升级入口，使用批准的计量构建。

“系统更新”更新 RayLink 软件，不自动升级 Linux 发行版或重启整台服务器。提交成功不是更新完成；以任务结果和实际版本为准。MCP 提供同等维护工具，遵守管理员角色和 Token scope。

## 验证边界

自动化覆盖真实本地 HTTP/HTTPS、证书校验、SSH 加密连接、Node 注册及任务回执、配置/订阅、更新 worker 子进程及浏览器逻辑。发布流水线还在全新 AMD64/ARM64 Linux runner 上执行实际安装、systemd 沙箱、BBR 读数、代理传输及更新回滚。云安全组、公网 CA 和手机运营商网络仍需真实服务器验收。上线后检查服务、端口、安全组、实际 BBR 读数、订阅和目标移动网络流量。
