# AI service routing coverage

Verified against the primary sources below on 2026-10-04. This is a maintained list of supported AI service domains, not an exhaustive list of every AI website or a guarantee that a provider accepts an account, location, or exit IP.

In smart mode, these domains use the selected **AI 网站代理** exit and its remote DNS policy. The same domain catalogue feeds routing diagnostics and the sing-box, Mihomo, and Egern subscription generators. Explicit administrator rules retain their priority. Direct and global-proxy modes retain their documented behaviour, and local infrastructure remains protected.

## Service catalogue

Suffix entries include the listed domain and its subdomains. Exact entries match only that hostname.

| Service | Suffix entries | Exact entries | Primary source |
| --- | --- | --- | --- |
| ChatGPT / OpenAI | `openai.com`, `chatgpt.com`, `oaistatic.com`, `oaiusercontent.com`, `oaistatsig.com` | Shared login and challenge dependencies are listed below | [OpenAI network recommendations](https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps) |
| Claude / Anthropic | `anthropic.com`, `claude.ai`, `claude.com`, `claudeusercontent.com` | Shared challenge dependency below | [Claude network requirements](https://code.claude.com/docs/en/network-config) |
| Gemini / Google AI Studio | `gemini.google.com`, `generativelanguage.googleapis.com` | `aistudio.google.com` | [Gemini API getting started](https://ai.google.dev/gemini-api/docs/get-started) |
| NotebookLM | — | `notebooklm.google.com` | [Google product URLs](https://support.google.com/legal-help-center/answer/16673757?hl=en) |
| Microsoft Copilot | — | `copilot.microsoft.com`, `copilot.cloud.microsoft` | [Consumer entry point](https://support.microsoft.com/en-us/microsoft-365-copilot/troubleshoot-content-copilot-app), [Microsoft Copilot network requirements](https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-copilot-requirements) |
| GitHub Copilot | `githubcopilot.com` | `copilot-proxy.githubusercontent.com`, `origin-tracker.githubusercontent.com` | [GitHub Copilot allowlist](https://docs.github.com/en/copilot/reference/copilot-allowlist-reference) |
| Grok / xAI | `x.ai`, `grok.com` | — | [xAI API reference](https://docs.x.ai/developers/rest-api-reference/inference), [Grok web entry point](https://docs.x.ai/grok/overview) |
| Perplexity | `perplexity.ai` | — | [Perplexity quickstart](https://docs.perplexity.ai/docs/getting-started/quickstart) |
| Poe | `poe.com` | — | [Poe API](https://creator.poe.com/docs/external-applications/openai-compatible-api) |
| OpenRouter | `openrouter.ai` | — | [OpenRouter quickstart](https://openrouter.ai/docs/quickstart) |
| Mistral | `mistral.ai` | — | [Mistral API setup](https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key) |
| Cohere | `cohere.com` | — | [Cohere API reference](https://docs.cohere.com/v2/reference/get-connector) |

The dedicated service suffixes are routing choices based on these documented service endpoints. A source confirming an API or entry point does not establish that every optional feature, regional endpoint, enterprise identity provider, or third-party resource has been tested.

## Shared provider boundaries

Existing exact dependencies are `cdn.openaimerge.com`, `cdn.workos.com`, `forwarder.workos.com`, `setup.workos.com`, `images.workoscdn.com`, and `workos.imgix.net`. OpenAI identifies these hosts in its network guidance.

`challenges.cloudflare.com` is a dedicated suffix entry, including its apex and verification subdomains. The [Cloudflare Turnstile changelog](https://developers.cloudflare.com/turnstile/changelog/) identifies `hagen.challenges.cloudflare.com` and `brunhild.challenges.cloudflare.com` as browser-verification hosts in its 2026-07-22 entry. Keeping only an exact apex entry left these hosts on the ordinary DNS and exit policy. The suffix change covers that challenge namespace without capturing other Cloudflare services. Cloudflare documents that completing a challenge from a different IP than the original request can produce a challenge loop. See [how Cloudflare challenges work](https://developers.cloudflare.com/cloudflare-challenges/concepts/how-challenges-work/).

This is a routing-consistency correction, not proof that a subdomain error caused a website failure. Cloudflare's [challenge troubleshooting guide](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/) explains that some challenge subdomain DNS probes deliberately fail and are non-blocking. A challenge response or a failed subdomain request alone cannot establish the failure's cause. The same-IP case also does not prove an exit-IP mismatch, and this correction does not demonstrate that a headless browser can complete a challenge.

The new Google, Microsoft, and GitHub shared-platform hosts are also exact matches. RayLink does not move all of `google.com`, `googleapis.com`, `microsoft.com`, `cloud.microsoft`, `githubusercontent.com`, `workos.com`, or `cloudflare.com` to the AI exit. Examples that retain normal routing include `mail.google.com`, `maps.googleapis.com`, `www.microsoft.com`, `outlook.cloud.microsoft`, and unrelated GitHub content. Child hostnames of an exact entry do not inherit its AI rule.

Shared sign-in endpoints such as `accounts.google.com`, `login.live.com`, and `login.microsoftonline.com` can serve AI and unrelated applications. They are not automatically moved to the AI exit. Microsoft documents these shared login dependencies in its [Copilot endpoint guidance](https://learn.microsoft.com/en-us/microsoft-365/copilot/add-copilot-endpoints-allowlist). Enterprise SSO and other identity-provider hosts are organization-specific. If a captured failing login flow shows that one needs the AI exit, an administrator can add an explicit hostname rule and validate that flow. Avoid claiming complete sign-in coverage from the AI entry-point catalogue alone.

Ordinary GitHub authentication, Google static resources, optional telemetry, billing resources, and cloud-side package downloads are not all AI traffic. Their appearance in a vendor allowlist is not sufficient reason to move an entire shared provider to the AI exit. New entries should have a vendor source or a reproduced network dependency and an adjacent-host negative test.

## Verification and limits

The 2026-10-04 coverage regression was reproduced before changing the catalogue:

- `node --test tests/routing-policy.test.js` failed because `aistudio.google.com` returned `action: proxy` instead of the AI policy.
- The real Mihomo DNS/route fixture failed in both legacy and modern formats: the AI Studio DNS query reached the ordinary remote resolver instead of the selected AI resolver.
- After the initial catalogue change, all 11 routing-policy tests passed. Both native formats passed 48 hostname cases each, checking actual DNS queries and HTTP proxy responses, including the new service entries, shared-provider neighbours, misleading suffixes, existing custom overrides, and domestic routing.
- A separate challenge-subdomain regression then failed before the suffix correction: `brunhild.challenges.cloudflare.com` used ordinary remote DNS in both native formats, and routing diagnostics returned a GeoIP decision. After the correction, both named verification hosts used AI DNS and routing, while Cloudflare siblings and misleading suffixes retained normal routing. Both native formats passed the expanded 53 hostname cases; the 11 routing-policy tests passed.

Run these checks with an installed Mihomo binary:

```sh
node --test tests/routing-policy.test.js
MIHOMO_BIN=mihomo node tests/ai-domain-routing-check.mjs
MIHOMO_BIN=mihomo node tests/ai-domain-routing-check.mjs --modern
```

These loopback fixtures prove generated DNS and routing behaviour. They do not prove a public website login, authenticated model generation, or mobile-network quality. Proxy transport should also be checked per protocol with strict TLS, sustained SSE, and WebSocket handshakes and idle connections. OpenAI specifically documents WSS for `ws.chatgpt.com` and `chatgpt.com`; both are covered by the existing ChatGPT suffix.

Report transport failures separately from HTTP authentication, rate limiting, region restrictions, and browser challenges. A `401` without an API key is not a completed model request, and a Cloudflare `403` challenge is not a successful website visit. Site acceptance requires the real supported browser or authenticated client flow.


## 可维护的 AI 域名识别（v0.2.43）

内置覆盖与客户端订阅共用 `server/routing/policy.js` 的域名源。管理员继续在「自定义规则」中添加完整域名或域名后缀，动作选择「AI 出口」；启用住宅时，同一组有序域名规则会编译到本机 Runtime。域名后缀包含主域名及子域名；需要单个 API 时使用完整域名。优先级较高的普通代理、直连或拦截例外仍优先，停用规则不参与。

住宅范围在客户端 AI 分组之上增加共享域名保护。Google、YouTube、X、Instagram、通用 Microsoft/GitHub 身份及 CDN 域名不能因宽泛 AI 规则进入住宅；现有 Gemini、Copilot 等内置专用域名保留例外。管理员新增的其他域名是显式分类，不是系统从网页内容推断其性质。未知域名、IP/CIDR 规则不会自动扩大住宅名单。

保存路由策略时，住宅启用则校验并尝试发布 Runtime，返回 `runtimeSync`；失败会保留待发布设置并显示 pending，可从 AI 出口重试发布。未启用住宅时返回 not-required，不重启 Runtime。保存后应在成功发布后刷新客户端**完整订阅并重新连接**；仅节点订阅不携带分流规则。

「AI 出口与检测」显示规则版本、内置域名、共享保护和自定义覆盖；「域名路由解释」显示命中来源、规则、住宅资格、预计出口和发布状态。诊断只是保存策略推断，并非手机测量；自定义 IP 优先规则可让客户端先解析目标，隐藏域名/ECH/IP-only 也可能让服务器无法识别。为识别而按共享 IP 扩大住宅范围不在本功能中。
