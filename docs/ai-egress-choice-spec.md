# AI 出口二选一

用户要求把“AI 入口主机”和“固定 AI 上游”两块配置合并为互斥的选择。审查基线：`668339d`。

## 行为约定

- 一个 AI 出口表单，服务器出口（默认）与住宅代理出口二选一，分别展示主机策略或 SOCKS5/HTTP/HTTPS 参数。
- 一次保存并发布；服务端事务同时切换模式与主机策略。服务器模式不提交或验证隐藏的住宅字段；住宅模式不接受单独的 AI 入口参数。
- 服务器模式关闭住宅上游但保留参数和加密凭据供以后复用；不改变既有分流模式及自定义规则。住宅模式沿用 smart/local 约束、AI 白名单和失败关闭策略。
- UI 区分编辑中、已保存、上次成功发布及待发布。发布失败不会把所选模式描述成运行中；dry-run 只表示模拟。
- 仍需刷新整份客户端订阅并重新连接，服务端发布状态不证明客户端已经切换。
- 沿用角色权限、会话隔离、凭据不回显与显式清除；普通 Google / 浏览不走住宅上游。
- 保持旧 API 和 MCP 工具兼容，增加统一读、写、重试发布接口与 MCP 工具。
- 无住宅供应商可供真实验收，默认不启用，不改生产代理参数。

## 接口

`GET/PATCH /api/settings/ai-egress`；`POST /api/settings/ai-egress/publish`（空对象）。
PATCH 接受 `{mode:"server", aiExit?:{mode:"auto"|"pinned",hostId?}}` 或 `{mode:"residential",upstream?:{type,server,port,username,password?,clearPassword?,tlsServerName}}`。
返回及 bootstrap.aiEgress：`{mode,aiExit,upstream,runtimeSync:{status,runtimeState,runtimeMode,publishedMode,message?}}`，upstream 不含明文密码。publishedMode 仅取已成功发布的安全快照元数据。

## 验收

公共 Store/API/MCP 行为红绿测试覆盖事务回滚、互斥结构、兼容、凭据保留、权限、幂等、发布失败/重试及 simulated 状态。隔离浏览器测试互斥显示、隐藏字段不阻塞、协议选项、保存失败、密码不回显和移动宽度。完成整体检查、独立规范/需求审查后发布部署；不把模拟或服务器观察宣称为真实住宅、手机或 AI 账号验收。
