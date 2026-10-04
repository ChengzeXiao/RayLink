# AI 专用上游代理

基准提交：`06039865d23375a11bc551870a55476827c85f0a`。用户要求增加可在界面配置的 SOCKS5、HTTP、HTTPS 住宅代理接口；仅 AI 网站、AI 专用登录及 API 走上游，Google 搜索与普通浏览保持原出口。用户暂未购买真实代理，本次使用可控代理验收，默认关闭。

## 范围

- 单个配置绑定现有 `local` 主控 Host，保留现有全部入站协议、用户凭据及计量。首次启用原子固定 smart / local；启用期间拒绝解除固定，停用不解除既有固定。
- 独立 GET/PATCH `/api/settings/ai-upstream`，POST `/api/settings/ai-upstream/publish` 重试发布；MCP 提供同等只读、保存、发布能力，沿用权限及幂等 requestId。
- 公开配置包含 enabled、hostId、type、server、port、username、tlsServerName、passwordConfigured、revision；密码只写，省略或空字符串保留，显式清除；服务端加密存储，客户端订阅与 API 不包含密码。HTTPS 严格校验证书。
- 保存后尝试验证并发布，明确展示 current / pending / simulated。发布失败不声称生效；原 Runtime 配置按现有发布机制回退。允许在尚无 Runtime 的环境保存待发布配置。
- 仅 AI 专用域名 TCP 走指定上游，相关 UDP 拒绝以便客户端使用 TCP；上游故障不配置 direct 回退。未知 IP、非 AI 域名、Google 搜索/Gmail/YouTube/共享第三方登录保持普通出口。共享验证/CDN不能仅凭域名识别AI用途，故不整段送住宅。
- 原始 AI 域名优先传给上游解析；嗅探仅补充识别。不能把 IP-only/ECH 无法识别的目标声称为已保证 AI 分流；不以此为由将全部 HTTPS 或共享 DNS 送住宅。
- 管理诊断在启用后经同一已配置代理进行固定目标匿名检查，标记 `control-plane-via-upstream` 与配置版本；不冒充已发布 Runtime、用户手机或登录账号的验证。缓存按配置版本隔离，不跟随重定向，限时/限流/限响应，校验目标公网地址及 TLS。

## 已授权测试边界

公开配置读写与重新打开后的持久化；HTTP/MCP 认证、权限和密码不回显；原生 sing-box 在可控 SOCKS5/HTTP/HTTPS 上游上的 AI 路由、普通网站隔离、故障不回退；实际表单保存/刷新/启停/密码保留、390px 布局；固定目标诊断的代理认证、TLS、超时和缓存来源。最后执行整体回归与独立 Standards/Spec 审查。

## 验收边界

本次无法验证供应商出口的住宅属性、真实公网固定 IP、真实 AI 账号或用户蜂窝网络。不会因为保存了代理配置就宣称这些项目通过。现有生产出口在没有真实供应商参数时保持关闭。

未配置或停用时，住宅出口不是正常 Runtime 发布和直接诊断的依赖；即使停用代理的旧密文无法解密，也不能阻塞上述功能。更新时保留已有密码，显式启用或回滚到不可解密的旧代理配置继续失败关闭。
