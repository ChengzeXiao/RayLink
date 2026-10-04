# AI domain recognition consistency

Baseline: `182e9a5246b4744dd2abb0a19bc20f3d5161ca13` (v0.2.42 acceptance).

User request: optimize AI traffic identification while ordinary browsing keeps its default egress.

- Reuse existing routingPolicy.rules; do not introduce another editable domain list. Custom domain/domain_suffix AI rules must affect full client subscriptions and enabled local residential Runtime. Ordered non-AI domain exceptions and disabled rules must be respected.
- Preserve built-in service coverage and normal behavior when residential is disabled. Shared providers and ordinary Google, YouTube, X, Instagram, shared identity and CDN domains must not be swept into residential by broad custom rules. Built-in dedicated AI subdomains remain eligible. Domain-only recognition is not content inspection or automatic learning; IP rules do not expand the residential list.
- Save routing policy under the existing Runtime operation lock; when residential is enabled compile/validate/publish changed configuration. Publication failures remain pending and are retryable via the existing AI publish action. Default egress changes do not restart Runtime. Never expose proxy credentials.
- UI and MCP expose rule version, built-in and custom coverage, matched rule, residential eligibility and reason, desired egress, publication state. Keep client rule inference distinct from actual Runtime publication and phone measurements.
- Reuse the existing rule editor, add readable AI coverage and navigation, and retain full subscription refresh/reconnect guidance. Do not overwrite unsaved AI egress drafts.
- Verify through the existing public seams: HTTP/MCP operations, generated subscription and Runtime configs, form submissions/rendered UI, and native local routing simulations. These extend the project's previously authorized test seams.

No new AI site claims, unauthenticated third-party rule downloads, scheduled learning, TLS decryption, or automatic changes of user egress are introduced.


## Added domestic-app regression scope

User reports Qianshou slow on Wi-Fi while Clash is in rule mode, then requests a broad domestic-app/network check. Native reproduction shows qianshouapp.cn selects remote DNS because the bundled China domain set omits it; policy.js already classifies .cn as domestic but full subscriptions did not compile this fallback. Fix this divergence by incorporating the existing CHINA_FALLBACK_DOMAIN_SUFFIXES into smart full subscription DNS and route behavior for sing-box, Mihomo and Egern, while preserving explicit custom/AI/overseas priority and complete reviewed China data. Do not rewrite verified upstream rule files or blindly direct shared CDN parents. Unknown non-CN domains retain the existing remote DNS/GeoIP behavior. Check representative domestic App domains and a synthetic unknown .cn, lookalikes, custom overrides, direct/global modes and IP-priority behavior. Client Wi-Fi latency and actual Qianshou account flows remain separate acceptance boundaries.
