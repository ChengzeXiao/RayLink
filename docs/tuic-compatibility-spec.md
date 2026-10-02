# TUIC 跨客户端兼容与自动配置

基线：v0.2.34 / 5cff12ace1cf1ce93f730a2413c976fcc2eaa731。

## 问题与证据

用户报告 TUIC 在 Wi-Fi 和移动网络均 timeout。已部署服务的证书、凭据、UDP 8447 监听和防火墙通过检查；同一节点的 sing-box TUIC 客户端能传输，但真实 Mihomo 1.19.25 客户端报 `tls: server did not select an ALPN protocol`。只在客户端添加 h3 仍然失败，服务端必须同步协商 ALPN。

## 验收要求

1. RayLink 管理的 TUIC 服务端与生成客户端统一使用 `tls.alpn: ["h3"]`，覆盖手动证书及 ACME；本机及远程 RayLink Node 的协议探测均沿用服务端 ALPN。远端修复发布为 Node 0.9.1，保留 0.9.0 的心跳、维护及滚动升级能力。
2. sing-box、Mihomo、Egern 和 Egern Profile 订阅保持相同 ALPN、凭据、SNI 和端口，继续验证生产证书；格式转换器不替外部导入配置凭空添加 ALPN。
3. 真实 Mihomo 与 sing-box 客户端使用生成配置经 TUIC 完整传输测试内容。去掉服务端 ALPN 的负向控制必须复现握手失败，排除 DIRECT 绕行。CI 使用批准的 sing-box 1.14.2 和校验 SHA-256 的固定 Mihomo 版本。
4. 新版本明确提醒更新 TUIC 订阅：旧 sing-box 空 ALPN 配置不能直接沿用。升级发布运行配置可能造成短暂重连；保留用户、凭据、额度和自然月历史，不再次清零。
5. 用户指出“配置 Shadowsocks 与防火墙”不能描述完整的自动安装。自动安装步骤名称应涵盖入口协议，实际处理已启用协议的防火墙和监听；新主机继承当前主机的可自动配置协议，缺少域名或需要专门配置的协议给出明确原因。

## 边界

保持 BBR 拥塞算法选择、内核 BBR 配置及路由策略。本次修复的是 TLS ALPN 握手兼容性，不声称更改算法可解决 UDP 被阻断的问题，也不把测试机公网验证当作用户手机实际验收。
