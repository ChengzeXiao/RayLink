# SSH 一键接入节点

在 **主机 → 添加主机** 填写 IP、SSH 端口、登录用户和密码或私钥，点击「一键接入」。名称和区域可选；默认名称 `VPS-IP`、区域 `global`。加密私钥可填写口令，普通用户可提供 sudo 密码或使用免密 sudo；密码登录时默认尝试同一密码进行 sudo。

控制面自动完成 SSH 身份检查、Linux/systemd 检查、依赖安装、Node 与计量 Runtime 安装、一次性注册、协议启用、配置发布、任务回执、运行与计量检查、公网协议测量、订阅内容验证。进度持久化，关闭页面不停止任务，可在主机页重新查看。手动安装命令入口仍然保留。

## 默认配置与订阅

- 只有 IP 时自动启用 **Shadowsocks 2022**，不依赖域名和证书。默认 TCP 443；SSH 使用 443 时选择 8443。目标端口被占用时沿用已有协议激活流程选择替代端口，不关闭其他服务。已有启用的 Shadowsocks 配置保留其端口。
- IPv4 地址使用 IPv4 公网监听，不要求服务器同时开启 IPv6；IPv6 地址使用 IPv6 监听。
- Node 使用主机上的 systemd 服务；安装批准的 sing-box **1.14.2 计量版**，支持 amd64/arm64。不会在新节点部署控制面或 Docker。
- 配置由现有协议/发布服务编译，包含符合节点区域、有效期、流量额度和启用状态的用户，沿用系统现有智能分流规则。
- `nodeScope=all` 或包含节点区域的有效用户刷新原订阅即可获取新节点；不修改用户权益，也不更换订阅 URL。支持现有 sing-box、Mihomo、Loon、Egern 等订阅格式。
- 无有效用户时节点可以就绪，结果明确为 `subscriptionStatus=awaiting-users`；创建或启用有权限用户后自动进入其订阅。`verified` 表示实际检查了每位有权限用户的配置输出。

## 自动域名与协议继承

默认先启用无需证书的 Shadowsocks，再根据域名设置继承本机已启用、可自动部署的公网协议。IP-only 或未启用 DNS 自动化时保留 Shadowsocks；需要域名的协议记录为 `DOMAIN_REQUIRED`，高级/私有协议记录为 `MANUAL_CONFIGURATION_REQUIRED`，结果列出跳过项。继承协议类型、传输参数、协议选项及首选端口，遇到端口冲突自动避让。用户凭据、权益、智能分流规则继续由控制面统一管理。

在 **系统 → 证书** 配置一次：

1. DNS 服务商选择 Cloudflare，填写 Zone ID、节点基础域名（如 `nodes.example.com`）、仅限目标 Zone 的 **Zone Read + DNS Edit** API Token，勾选自动分配域名；Token 留空保留已保存值。
2. 填写证书通知邮箱。接入选择「自动分配域名」，生成稳定的 `node-<Host编号>.nodes.example.com`，自动创建 DNS-only A/AAAA 记录并验证解析。
3. 其他 DNS 服务商可选择「使用已解析域名」，提前把独立域名完全解析到该节点 IP。选择「仅 IP」则仅使用 Shadowsocks。

SSH 管理 IP 与 `endpointDomain` 分开保存，不因启用域名改变机器身份。客户端连接、TLS SNI 和公网探测使用节点业务域名；订阅 IP 优先策略仍可使用验证过的节点 IP，TLS server_name 保留域名。主机证书文件路径、证书私钥不复制到新节点。

远程 sing-box 1.14.2 同域名协议共享一个自动续期 ACME provider；仅使用 **HTTP-01 / TCP80**，避免默认 Shadowsocks TCP443 与 TLS-ALPN 挑战冲突。80 必须可绑定且公网可达；云安全组须同时放行 80 和所启用协议端口。证书缓存写入 Node Runtime 数据目录下 `acme`，符合 systemd 写入限制。端口80被其他服务占用时明确失败，不停止原服务。节点 TLS 协议未启用时不会仅为 Shadowsocks 申请无用证书。

DNS Token 仅主控使用，以独立上下文从服务端加密密钥派生 AES-256-GCM 密钥持久化，不回显、下发 Node 或进入订阅/审计。备份数据库和服务端主密钥应按敏感配置保存，恢复时保留原主密钥。自动 DNS 校验 Zone 所属、拒绝覆盖非本节点记录；写入响应丢失先读取确认，重试不会重复创建。失败保留原 Host、已启用的 Shadowsocks 和已创建 DNS 记录，修复解析/权限后从同一任务继续；不会自动删除外部记录。

设置接口为 `GET/PATCH /api/settings/node-domains`，GET 所有管理员可读，PATCH 仅 Owner；MCP 对应 `node_domains_get`（read）与 `node_domains_update`（system.manage）。保存设置本身不修改 DNS。首次自动接入时调用官方 [Zone Details](https://developers.cloudflare.com/api/resources/zones/methods/get/) 和 [DNS Records API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/)。

## 接入条件

目标服务器需要 Linux、systemd、root 或 sudo 权限，以及到控制面与软件源的出站连接。控制面必须配置服务器可访问的 HTTPS 根地址；公网域名使用受信任证书，默认 IP 模式由控制面将本地证书通过已核验的 SSH 通道传给节点，安装下载和后续 Node 连接均严格校验证书及地址；本地开发的 `127.0.0.1` 地址不能用于远程安装。支持纯 IPv4/IPv6 地址和 VPC 内网地址；拒绝回环、未指定、链路本地和组播地址。

安装器按需处理系统依赖，验证下载文件及 Runtime 构建标签。协议激活处理主机侧的受管理防火墙规则。云厂商安全组需要允许最终协议端口；仅有 SSH 凭据无法修改云账号侧的安全组。公网测量不通过会显示失败，不能把安装成功当成业务可用。服务端测量也不能代替用户所在移动网络的实际体验验证。

## 恢复与身份保护

SSH 密码、私钥、口令和 sudo 密码不写入数据库、任务结果或审计。远程执行的参数不携带这些秘密，安装凭据经 SSH 标准输入传递。首次接入固定服务器 SHA-256 Host Key 指纹，后续重试出现变化会拒绝连接；这是首次信任，不替代已有可信指纹的线下核实。

任务与 Host 绑定原子保存。服务重启后未结束任务标记 `interrupted`，不会凭空重建凭据或另一台 Host；对同一任务显式重试，未完成 SSH 安装时重新提供凭据。已注册且在线的节点可直接继续配置验证。已安装的同一节点使用原身份；不同控制面或不明身份的安装会被拒绝。部分安装通过保存在远端的 Host 标记及原注册凭据继续，不轮换已有订阅或覆盖外部 Runtime。

同一 `requestId` 的网络重试复用已有任务。失败后发起新的尝试使用原 job 的 retry 接口和新的 `requestId`；不能通过换 start 编号绕过失败任务创建另一条 Host。当前一次执行一个接入任务，避免并发配置发布相互覆盖。等待阶段有时限，SSH 安装最多 20 分钟；失败会保留已安装内容和已创建 Host 供修复续接，不自动卸载服务器。

## HTTP 和 MCP

浏览器会话写入要求 `runtime.manage`：

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/api/hosts/provision` | 创建接入任务，返回 HTTP 202 与 `{job}` |
| GET | `/api/hosts/provision` | 读取任务列表 `{jobs}` |
| GET | `/api/hosts/provision/:id` | 读取进度与结果 `{job}` |
| POST | `/api/hosts/provision/:id/retry` | 重新尝试原任务，返回 HTTP 202 与 `{job}` |

创建输入：`requestId, host, port=22, username=root, password 或 privateKey, passphrase?, sudoPassword?, name?, region?, domainMode=auto|existing|none, endpointDomain?, inheritProtocols?`。重试输入：新的 `requestId`，必要时附带认证字段。返回信息没有 SSH/Node 凭据。

MCP 使用 `hosts_provision_start`、`hosts_provision_list`、`hosts_provision_get`、`hosts_provision_retry`。启动/重试必须同时具备 **`runtime.manage` 与 `hosts.provision`**；已有 Runtime 管理令牌不会自动获得 SSH 权限。开始调用返回任务编号后，Agent 应轮询 get 直到 `succeeded/failed/interrupted`；异步操作的 202 不是完成证明。

```json
{
  "name": "hosts_provision_start",
  "arguments": {
    "requestId": "add-hk-node-001",
    "host": "203.0.113.10",
    "port": 22,
    "username": "root",
    "privateKey": "<SSH 私钥>",
    "name": "香港节点",
    "region": "hk"
  }
}
```

## 验证边界

自动化测试覆盖真实 SSH2 加密连接、密码与私钥认证、Host Key 变化、sudo 输入、安装器 shell 恢复、真实 Node 的 HTTP 注册/回执、持久任务、用户范围与订阅输出、MCP 权限和浏览器交互。远端软件包/Runtime/systemd 使用隔离模拟，不代表已在某台公网 VPS 部署。实际服务器接入还应检查云安全组、软件源、HTTPS 信任以及移动网络客户端。

验证命令：`node --test tests/ssh-bootstrap.test.js tests/ssh-node-install.test.js tests/node-provisioning*.test.js`；全项目回归 `npm run check`。

2026-10-01 本地验收：最终 `npm run check` **402/402 通过**。模拟流程验证真实 Node HTTP 注册、发布回执、计量及五种订阅格式，覆盖端口自动避让、认证失败、协议公网探测失败、同 Host 重试和进程 SIGKILL 后恢复；真实 SSH2 测试验证密码、私钥、sudo 和指纹固定。桌面与 390px 浏览器检查了认证方式切换、凭据清空、进度和失败重试。以 `e5ef11d` 为基线的 Standards / Spec 复核无尚未修复的 P1/P2；公网 VPS 和移动网络不在此次本地验收范围内。

本次域名扩展的模拟测试覆盖 Cloudflare 外部边界、DNS 传播失败恢复、真实 Node HTTP 回执、多协议独立证书配置、五种订阅输出与原订阅地址保持；另用真实 sing-box 1.14.2 校验共享 provider 配置。DNS 写入、公开 CA 实际签发/续期和真实 VPS 均需要对应环境实测。

2026-10-01 MCP Server / 账号 / 域名自动化验收（基线 `8b49e2d`）：`npm run check` 共 451 项，450 通过、0 失败、1 项原生环境检查默认跳过；该项已另以真实 sing-box 1.14.2 运行并通过。覆盖密码/登录并发、会话与 MCP Token 撤销、DNS 设置作用域和幂等、Cloudflare A/AAAA 与错误 Zone 恢复、DNS 传播失败续接、协议继承及五种订阅格式；QUIC 的 UDP 激活、监听、防火墙和测量经过专项回归。Standards / Spec 复核发现的问题已修复，无剩余已确认 P1/P2。桌面 UI 完成只读验收，表单提交由公开 handler 和 HTTP 测试覆盖；本轮未进行公网 DNS/CA/VPS 写入、生产部署或移动网络实测。

## BBR 与后续维护

Node 0.9.0 自动尝试加载 BBR、持久化 `fq` 与 `bbr` 参数，并在心跳中上报实际内核读数。主机列表/详情显示 BBR 状态、拥塞控制、队列算法和采样时间；节点离线或数据超过 60 秒不再显示当前已启用。内核不支持时给出原因，节点其余功能继续运行。管理员可重试 BBR 配置，待任务回执及新心跳确认后才显示生效。

Owner 可在主机详情更新 Node 程序；0.7/0.8 旧节点先执行一次页面提供的升级命令。Node 程序更新保留身份、控制面 CA、Runtime/Cronet 和配置；更新任务由独立 systemd 服务执行，重启后核验实际版本并回报结果。BBR 影响 TCP，不能等同于 QUIC/UDP 加速或保证移动网络速度。
