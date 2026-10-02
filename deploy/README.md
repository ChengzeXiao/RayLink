# RayLink 单机生产部署

以下示例面向 Debian/Ubuntu + systemd。路径约定：

- 应用：`/opt/raylink`
- 数据：`/var/lib/raylink`
- 环境：`/etc/raylink/raylink.env`
- 受管配置：`/var/lib/raylink/sing-box/config.json`

正式发布包包含 `package-lock.json` 和生产 `node_modules`，构建时在隔离目录执行
`npm ci --omit=dev --ignore-scripts`。安装与升级会在候选目录校验锁文件、已安装版本和控制面模块导入；
依赖检查失败不会切换应用或停止旧控制面。完整发布包的依赖检查无需访问 npm registry；
直接从源码安装时需要 npm registry 可达（或本机已有完整 npm 缓存）。
远程 RayLink Node 使用独立脚本，不安装控制面的 MCP SDK 依赖。

## 推荐：一键安装与首次初始化

v0.2.34 支持 AMD64（x86_64）和 ARM64（aarch64）。服务器需要预先具备 `curl`。发布产物与升级说明见 GitHub Release。
使用 root 登录时，直接复制执行这一条命令：

```bash
bash -o pipefail -c 'curl -fsSL https://github.com/ChengzeXiao/RayLink/releases/download/v0.2.34/install.sh | bash'
```

普通用户登录时，把管道中的 `bash` 改为 `sudo bash`：

```bash
bash -o pipefail -c 'curl -fsSL https://github.com/ChengzeXiao/RayLink/releases/download/v0.2.34/install.sh | sudo bash'
```

脚本检测 CPU 架构和公网 IP，自动补齐 Debian/Ubuntu 上缺少的归档校验工具，
下载固定版本发布包和 `.sha256`，校验通过后才会解压并执行控制面安装器。
云主机若有 NAT、多块网卡，建议显式提供实际访问地址：

```bash
bash -o pipefail -c 'curl -fsSL https://github.com/ChengzeXiao/RayLink/releases/download/v0.2.34/install.sh | bash -s -- --public-ip 203.0.113.10'
```

安装指定版本：

```bash
bash -o pipefail -c 'curl -fsSL https://github.com/ChengzeXiao/RayLink/releases/download/v0.2.34/install.sh | bash -s -- --version 0.2.34'
```

只验证下载、校验和解压，不修改系统：

```bash
bash -o pipefail -c 'curl -fsSL https://github.com/ChengzeXiao/RayLink/releases/download/v0.2.34/install.sh | bash -s -- --dry-run'
```

一键安装会完成：

- 从 Node.js 官方源安装并校验 Node.js 22；
- 优先校验并安装发布包内预编译的 sing-box 1.14.2 计量版；
- 开发源码包未携带预编译 Runtime 时，才回退到本机编译；
- 从 Caddy 官方 APT 仓库安装 Caddy，并配置 systemd 自启动；
- 安装 RayLink 和 sing-box systemd 服务；
- 为服务器 IP 生成带 SAN 的首次访问证书；
- 自动创建管理员、启用 Shadowsocks、配置 BBR、发布配置并验证服务与监听端口；
- 将初始登录信息写入 `/etc/raylink/initial-login.json`（权限 0600）。

已经下载发布包时，也可以在发布包根目录直接执行底层安装器：

```bash
sudo env RAYLINK_PUBLIC_IP=203.0.113.10 bash deploy/install-control-plane.sh
```

浏览器首次访问 IP 证书会提示证书由本机签发。继续前应核对安装器输出的
SHA-256 证书指纹。受管 Node 经 SSH 获得主控证书并保持严格 HTTPS 校验；浏览器、MCP 和订阅客户端仍需要信任该证书。自动化安装使用一次性初始化令牌，成功后立即作废。

已有解析到服务器的域名时，可以执行：

```bash
sudo env RAYLINK_PUBLIC_IP=203.0.113.10 RAYLINK_DOMAIN=panel.example.com RAYLINK_ACME_EMAIL=ops@example.com bash deploy/install-control-plane.sh
```

Caddy 自动申请并续期域名证书；控制台和订阅使用该域名，仍保留 IP 恢复入口。需要分别配置域名时，设置 `RAYLINK_INTERACTIVE_SETUP=true` 保留交互向导。详见 [自动安装与维护](../docs/automatic-installation.md)。

### 升级到 v0.2.34

在已安装 RayLink 的服务器上重新执行同一条一键命令即可。安装器会识别
`/opt/raylink`，保持 sing-box Runtime 运行，备份当前应用和
`/var/lib/raylink` 数据，原子替换控制面并执行健康检查。新版本未能正常启动时，
升级器会自动恢复应用、数据和 systemd 服务单元：

```bash
bash -o pipefail -c 'curl -fsSL https://github.com/ChengzeXiao/RayLink/releases/download/v0.2.34/install.sh | bash'
```

升级备份保存在 `/var/backups/raylink/`。新版还支持在「系统 → 版本与备份」检查正式 Release 并更新控制面；独立 systemd 更新任务在主控重启后保留结果，重新验证实际版本及服务状态。Node 0.9.0 起支持同样的远程程序更新；更旧 Node 需先执行一次升级命令。软件更新不执行发行版升级，也不自动重启服务器。

### 从旧版本升级到 v0.2.12

升级前备份 `/var/lib/raylink`。首次启动 v0.2.12 前，在
`/etc/raylink/raylink.env` 中固定一个独立随机值：

```text
RAYLINK_SUBSCRIPTION_ENCRYPTION_KEY=<长期固定的随机密钥>
```

该值用于加密可再次查看的订阅 bearer，后续不得随管理员密码一起轮换。停止控制面后，
可在 v0.2.12 安装目录执行下列命令，把旧的一键 Reality 入口迁移到 Host 域名证书
TLS；包装脚本会安全加载生产环境并使用 RayLink 内置 Node.js。每个协议独立原子发布，
逐个执行真实 sing-box 握手，当前协议失败即回滚：

```bash
sudo bash deploy/migrate-default-tls.sh
```

### 发布时预编译 Runtime

正式版本同时发布独立的 `linux-amd64` 和 `linux-arm64` 安装包，避免每台 VPS
重复下载 Go 模块和编译。GitHub Release 工作流分别在原生 AMD64 与 ARM64
Linux Runner 上执行：

```bash
sudo bash deploy/build-runtime-artifact.sh 1.14.2
```

默认产物写入 `web/node/runtime/`。每个架构包含计量版 sing-box、独立
SHA-256，以及从同版本官方发布包提取并按固定 SHA-256 验证的 `libcronet.so`
伴随组件；后者用于执行真实 Naive 协议探针。控制台首机安装和后续 RayLink Node
接入都会按 VPS 架构选择同一组产物，验证完整性、sing-box 版本及审批 build tags
后直接安装。仓库源码不提交大型二进制，正式发布流水线负责生成并装配这些产物。

也可以指定自定义目录；相对路径会先转换为绝对路径，避免构建器拒绝：

```bash
sudo bash deploy/build-runtime-artifact.sh 1.14.2 ./release-runtime
```

第三个参数可以指定目标架构，例如在 ARM64 构建机上交叉构建 AMD64：

```bash
sudo bash deploy/build-runtime-artifact.sh 1.14.2 ./release-runtime amd64
```

交叉构建阶段会验证目标 ELF 架构；发布前还必须在 AMD64 Linux 用户空间执行
`raylink-sing-box-1.14.2-linux-amd64 version`，确认版本和完整审批 build tags。
原生架构构建会在脚本内部直接完成这项执行校验。

本地也可以在 Runtime 产物准备完成后构建单架构正式安装包。v0.2.34 默认装配
AMD64 Runtime：

```bash
bash deploy/package-release.sh 0.2.34
```

也可以显式指定本次发布需要装配的架构：

```bash
RAYLINK_RELEASE_ARCHES=amd64 bash deploy/package-release.sh 0.2.34
```

发布包包含运行程序、部署工具、README、变更日志和生产门槛文档，不会打包本地
`data/`、测试数据库或开发输出。每个架构会同时生成：

- `.tar.gz` 正式安装包；
- `.tar.gz.sha256` 独立校验文件；
- `.manifest.json` 机器可读发布清单；
- `.spdx.json` SPDX 2.3 SBOM。

推送与 `package.json` 相同版本的 `v*.*.*` Tag 后，流水线会为所有发布资产生成
GitHub Build Provenance 证明并发布 Release。ARM64 安装器使用与 AMD64 相同的一键
命令，会自动按 `uname -m` 下载匹配的安装包。

控制面升级会先停止 SQLite 写入、创建恢复点，再由候选版本在隔离副本上执行数据库
迁移、`PRAGMA integrity_check` 和外键检查。只有兼容检查通过后才切换应用目录。

若令牌过期，在服务器上执行以下命令可安全轮换令牌。新明文令牌仍只显示一次，
服务器只保存其哈希：

```bash
bash /opt/raylink/deploy/rotate-setup-token.sh
```

默认自动执行首次初始化。选择 `RAYLINK_INTERACTIVE_SETUP=true` 时，向导包含五步：

1. 验证一次性安装令牌；
2. 选择域名或 IP 访问入口；域名模式分别填写控制台域名和订阅域名，由 Caddy
   检查 DNS、自动申请证书并配置续期；
3. 创建正式管理员；
4. 设置本机 Runtime 名称、节点连接地址和区域；
5. 检查并进入控制台。

提交最后一步后，RayLink 会先检测 Linux 内核的拥塞控制能力，再自动加载
`tcp_bbr`、启用 `net.core.default_qdisc=fq` 和
`net.ipv4.tcp_congestion_control=bbr`。配置会持久化到
`/var/lib/raylink/managed/99-raylink-bbr.conf`，并通过
`/etc/sysctl.d/99-raylink-bbr.conf` 在重启后继续生效。初始化界面会实时显示
安装与 BBR 配置进度；内核不支持或配置失败会记录待处理项，不阻断其余可用服务。主机页可查看真实状态并重试配置，不会把不支持的内核标为已启用。

没有域名时可以长期使用 IP HTTPS；浏览器需要信任安装器生成的本机证书。使用域名时
必须先把 A/AAAA 记录直接解析到该 VPS（初始化时关闭 CDN 代理），并开放 TCP 80/443。
Caddy 切换域名后仍保留 IP HTTPS 入口用于恢复。

## 手动安装

安装 Node.js 22.5+ 和审批版本的 sing-box，然后创建目录：

```bash
install -d -m 710 -o root -g caddy /var/lib/raylink
install -d -m 750 -o root -g caddy /var/lib/raylink/managed
install -d -m 700 /etc/raylink
```

将项目复制到 `/opt/raylink`，根据 `raylink.env.example` 创建
`/var/lib/raylink/managed/raylink.env`，将初始 Caddyfile 放到同一目录，并建立兼容链接：

```bash
ln -sfn /var/lib/raylink/managed/raylink.env /etc/raylink/raylink.env
ln -sfn /var/lib/raylink/managed/Caddyfile /etc/caddy/Caddyfile
cp deploy/raylink.service /etc/systemd/system/raylink.service
cp deploy/sing-box-raylink.service /etc/systemd/system/sing-box-raylink.service
systemctl daemon-reload
systemctl enable --now raylink
```

先保持 `RAYLINK_RUNTIME_MODE=dry-run`。在控制台完成主机配置并发布一次，然后执行：

```bash
sing-box check -c /var/lib/raylink/sing-box/config.json
```

确认通过后：

```bash
systemctl enable --now sing-box-raylink
sed -i 's/RAYLINK_RUNTIME_MODE=dry-run/RAYLINK_RUNTIME_MODE=systemd/' /etc/raylink/raylink.env
systemctl restart raylink
```

RayLink 的 systemd 模式会重启 `sing-box-raylink.service`。示例为了让配置写入、读取、
服务重启和首次 Caddy 配置切换权限一致，以 root 运行 RayLink；服务只监听回环地址，
外部 HTTPS 由 Caddy 提供。若要使用非 root 账号，应另外配置严格的 polkit、文件组和
Caddy 管理权限。

`RAYLINK_PROTOCOL_PROBE_URL` 用于 Hysteria、TUIC 和 Hysteria2 的协议级验收，
默认是 `https://www.gstatic.com/generate_204`。节点会用刚发布的真实协议配置访问
该 HTTPS 地址，成功后才报告“公网可用”；自定义地址必须稳定返回并使用受信任证书。

## Caddy 与域名初始化

安装阶段 Caddy 使用 IP 证书代理 `127.0.0.1:4173`。在首次初始化界面选择域名后，
RayLink 会：

1. 检查控制台域名和订阅域名的 A/AAAA 是否直接指向当前 VPS；
2. 校验候选 Caddyfile；
3. 为控制台和订阅域名分别建立站点并等待自动签发证书；
4. 分别持久化 `RAYLINK_PUBLIC_ORIGIN`、`RAYLINK_SUBSCRIPTION_ORIGIN` 和 Host 节点地址；
5. 从本机使用两个域名的 SNI 验证证书链和 HTTPS 确实可用；
6. 保留 IP HTTPS 站点作为恢复入口；
7. 任一步失败时恢复原 Caddyfile 和环境文件。

订阅域名只转发 `/sub/*` 和 `/rule-sets/*`，其他路径统一返回 404；Host 节点地址
用于生成 sing-box 客户端连接配置，不参与控制台或订阅 HTTP 路由。

一键安装把受管 Caddyfile 和环境文件存放在 `/var/lib/raylink/managed/`，并从
`/etc/caddy/Caddyfile`、`/etc/raylink/raylink.env` 建立兼容链接。这样控制面不需要
写入整个 `/etc/caddy` 或 `/etc/raylink` 目录。

生成的 Caddyfile 默认不开启访问日志，避免包含配置 URL 密钥的 `/sub/` 地址落盘。
若自行增加日志，必须对 `/sub/` 路径禁用或脱敏。Caddy 的自动 HTTPS 需要公网 TCP
80/443；证书申请和续期由 Caddy 管理。

不要通过公网直接暴露 4173。

## 检查

```bash
systemctl status raylink
systemctl status sing-box-raylink
systemctl status caddy
journalctl -u raylink -n 100 --no-pager
journalctl -u sing-box-raylink -n 100 --no-pager
journalctl -u caddy -n 100 --no-pager
```

配置发布失败时，RayLink 会保留上一份活动配置；首次发布失败则不会留下未启动的活动文件。
