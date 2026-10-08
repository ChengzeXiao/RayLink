# RayLink Changelog

## 0.2.47 - 2026-10-08

- Require explicit credential-read permissions in REST/MCP, redact Host protocol secrets from overview roles, and audit successful sensitive reads without storing credentials.
- Recompile rollback authentication from current entitlements and credentials so historic deployments cannot restore revoked access; a broken current AI upstream no longer blocks a valid historical rollback.
- Release Node 0.9.2 with persisted enrollment keys, atomic encrypted enrollment receipts and same-key retry recovery; retain Node 0.9.0/0.9.1 rolling compatibility.
- Give new users immutable Runtime identities, preserve existing installed usernames, quarantine ambiguous legacy aliases and share counter watermarks across aliases. Bill remote usage only within successfully applied Host grant intervals.
- Reject stale in-flight password logins after a password or account change, reserve source/account/global verification budgets before asynchronous authentication, and release budgets on every completion path.
- Bind Runtime application evidence to active configuration, systemd InvocationID and known TLS assets; skip identical verified local/remote publications without hiding drift. Separate committed UI operations from subsequent refresh errors.
- Fix Mihomo HTTPUpgrade export and ordinary-domain Runtime DNS fallback when an AI residential upstream is enabled, preserving AI-only routing and failure-closed behavior.
- Local validation passed 797/797 tests plus isolated native protocol, metering, DNS, AI upstream and long-connection checks. Formal Linux release CI and production/device acceptance remain separate gates; this release adds SQLite migrations and requires the default full-data rollback path.

## 0.2.46 - 2026-10-07

- Fix unlisted domestic App/CDN traffic receiving overseas DNS answers in smart Mihomo subscriptions: accept only CN-address domestic candidates, otherwise use proxied DNS.
- Derive the DNS rejection filter from the same reviewed CN ranges as routing, add a second domestic DNS endpoint, and preserve explicit AI/overseas/custom policies and manual fallback.
- Add native DNS/HTTP regressions for CDN branching, mixed and invalid answers, resolver failures, and AI isolation. Other client formats and global modes retain their existing behavior.

## 0.2.45 - 2026-10-06

- Use reviewed geographical CN IP data instead of ISP registered-country classification for domestic fallback, preserving IPv4/IPv6 and consistent binary/inline subscriptions.
- Keep explicit AI, overseas and custom rules ahead of CN IP matching; retain manual AI choices and the unclassified selector.
- Add native regression coverage for domestic cloud addresses with overseas registration and publish reproducible source provenance.

## 0.2.42 - 2026-10-04

- 将“AI 入口主机”和“固定 AI 上游”合并为 AI 出口二选一：默认出口或住宅代理出口，按选择展示并提交配置。
- 统一事务切换主机策略与代理开关，保留住宅凭据和原有分流规则；发布失败展示已保存与最近发布模式，支持重试。
- 新增统一 AI 出口 REST 与 MCP 读、写、发布接口，保留旧接口兼容、权限与幂等保护。
- 保持 AI 专用流量范围及失败关闭行为；Google 与普通浏览继续原出口。

## 0.2.41 - 2026-10-04

- Add disabled-by-default AI-only SOCKS5, HTTP and HTTPS upstream configuration through the UI, REST and MCP, with credential encryption and explicit publication state.
- Route recognized dedicated AI domains through the upstream while preserving ordinary Google, shared login/challenge services and other browsing on the existing egress. Preserve inbound protocols and reject unsupported AI target UDP without a direct fallback.
- Diagnose through the configured proxy with strict TLS, bounded requests, revision-isolated caching, and separate proxy-authentication outcomes; preserve credentials during updates and encrypt residential passwords in deployment history.
- Gate releases on isolated native proxy tests covering transport compatibility, ordinary-traffic isolation, authentication failures and TLS verification. No residential account or authenticated AI model test is implied.

## 0.2.40 - 2026-10-04

- Pin AI selections to a stable Host ID across complete sing-box, Mihomo and Egern exports while retaining all authorized compatible protocols. Fail closed for AI when the pinned Host is unavailable, and preserve the pin when older clients omit it.
- Add anonymous, bounded AI site diagnostics in the management UI and MCP, separating DNS/TLS/transport failures from challenges, authentication, permissions and rate limits without changing routing.
- Add native Host-isolation and same-Host recovery checks to the AI release gate, including missing/ineligible Hosts and a deliberate leakage negative control.
- Preserve User data, monthly traffic, credentials and the running sing-box Runtime during an application-only upgrade.

## 0.2.35 - 2026-10-02

- Negotiate h3 ALPN consistently for managed TUIC listeners, client subscriptions and local/remote probes; existing TUIC subscriptions must be refreshed after upgrading.
- Release RayLink Node 0.9.1 with the remote probe fix while retaining 0.9.0 maintenance and rolling upgrade support.
- Configure firewall rules and verify listeners for every enabled protocol during automatic Runtime setup, preserving existing settings and private/loopback exposure boundaries.
- Rename setup progress to “配置入口协议与防火墙”, including persisted historical labels, and verify multi-protocol remote provisioning and retries.
- Gate releases on real Mihomo and sing-box TUIC transfers plus an ALPN failure control, using a checksum-pinned Mihomo test client.

## 0.2.34 - 2026-10-02

- Reset traffic allowances at the beginning of each Asia/Shanghai calendar month, including catch-up after downtime, with durable usage history and idempotent migration.
- Archive and clear legacy usage once on first activation; preserve credentials, entitlements and monthly usage on subsequent upgrades.
- Expose usage periods and history in the administrator UI, User Center and MCP; reject stale-period usage adjustments and retry remote entitlement publication until applied.

## 0.2.33 - 2026-10-02

- Fix Linux Node installer/updater preflight imports inadvertently starting the daemon and blocking completion.

- Fix whole-client startup on sing-box 1.14.2 by removing the empty direct DNS detour; embed complete routing rules for IP self-signed deployments without weakening TLS verification.
- Allow ACME writes in a dedicated systemd state directory while retaining read-only Runtime configuration.
- Resume interrupted first installations with private ownership/state checks and preserved credentials, certificates and encryption keys.
- Reject IP changes on domain-bound Hosts before mutation to prevent stale DNS and subscription endpoints.
- Gate releases on native Linux installation, HTTPS, actual Shadowsocks traffic/metering/revocation, MCP, kernel BBR telemetry and application upgrade/rollback checks on both architectures.

- Complete unattended first installation with generated administrator credentials, default Shadowsocks, publication and runtime/listener checks; retain an optional interactive setup.
- Add automatic Linux BBR configuration and fresh kernel telemetry in host lists/details; show unsupported, failed, stale and offline states explicitly.
- Add durable independent control-plane and Node 0.9.0 update workers, post-restart version checks, maintenance permissions and MCP tools.
- Pin the IP control-plane certificate over verified SSH for strict Node HTTPS, and support automatic Caddy domain setup from installer environment settings.

- Add a persistent localhost control-plane entry without simulated users or nodes; surface the HTTPS prerequisite before accepting SSH credentials.
- Show disconnected control-plane status, back off read polling and reconnect without replaying writes or clearing SSH onboarding forms; require fresh reads after login and successful writes.
- Initialize the first administrator only when the database has no administrators, preventing renamed credentials from being recreated on restart.

- Add SSH onboarding with durable jobs, pinned host keys, password/key authentication, resumable installation, automatic protocol publication, metering and subscription verification.
- Add MCP Server management over Streamable HTTP with 52 scoped tools and an Owner Bearer Token console; SSH onboarding requires a separately granted hosts.provision scope.
- Add current-password-verified administrator username/password changes, session revocation and MCP token revocation on password reset; prevent stale concurrent logins from restoring access.
- Automate Cloudflare node subdomains, retain separate SSH IPs, inherit enabled public protocols and verify existing subscriptions; preserve working Shadowsocks when domain setup needs retry.
- Share remote ACME providers on sing-box 1.14, use the Node writable certificate directory and HTTP-01 TCP80, and activate QUIC transports over UDP.
- Encrypt durable MCP write outcomes, deduplicate retries across restarts, and report uncertain crash outcomes without blindly reapplying changes.
- Bundle locked production npm dependencies, validate them before service switching, and include them in release SBOMs.

- Resolve hostname requests before IP routing, preserve explicit rule priority, and align system/domestic/AI DNS with their selected exits.
- Default sing-box to TCP candidates, give AI an independent stable selection, and preserve active connections during policy changes.
- Correct Egern top-level selection and provide complete verified offline China rules, atomic rule-set updates and visible version/degradation status.
- Distinguish control-plane DNS predictions from measured client routing, including mixed-IP and oversized-response warnings.
- Add native smart-routing and failover simulations with a negative control for AI exit stability.
- Upgrade the approved metered sing-box Runtime to 1.14.2 and the builder to Go 1.26.8.
- Migrate ACME per Host version and enable bounded optimistic DNS caching in 1.14+ client configurations.
- Add Node 0.9.0 program-only updates, preserve the Runtime/Cronet pair during application upgrades, and gate Runtime upgrades on the Node version.
- Add real protocol traffic, User metering/revocation, DNS outage and Node update rollback checks.
- Preserve successful User saves during refresh failures and correct mobile fallback and DNS routing behavior.

## 0.2.32 - 2026-08-25

### Fixed

- Mihomo DNS suffix policies now use the supported `+.suffix` syntax for local
  and custom domain suffixes, preventing Mihomo 1.19.30 from rejecting generated
  subscription configurations while preserving exact-domain rules.

## 0.2.31 - 2026-08-25

### Fixed

- Loon subscriptions now emit the current `sni` TLS option for VMess, VLESS,
  Trojan, AnyTLS, and Hysteria 2 nodes. IP dial endpoints therefore retain the
  Host certificate identity instead of failing TLS validation in Loon.

## 0.2.30 - 2026-08-25

### Changed

- Host identity now remains a domain in stored and rendered configurations while
  RayLink resolves and health-checks its current IPv4 dial endpoint through
  trusted DNS with TTL caching.
- Universal subscriptions adapt the resolved endpoint per client: Mihomo keeps
  the domain with a pinned hosts mapping and Fake-IP exclusion, sing-box uses a
  dedicated hosts resolver, and Loon/Egern dial the IP while retaining TLS SNI.
- Endpoint resolution persists the last-known-good address and falls back to the
  installation public IP when DNS or health checks are unavailable.

## 0.2.29 - 2026-08-24

### Fixed

- Local Host client subscriptions can publish a validated public IP as the
  dial address while preserving the Host domain and protocol TLS SNI, avoiding
  Fake-IP loops when clients resolve the node server through their tunnel.
- Fresh installs and upgrades persist the local Host dial IP automatically;
  failed upgrades restore the previous environment file together with the
  application, data, and service unit.

## 0.2.28 - 2026-08-24

### Changed

- Loon links in the subscription API, administrator console, user portal, and
  browser landing page now use the clean universal URL without a format query
  or filename suffix. Loon User-Agent negotiation selects the native node
  format automatically.
- Centralized subscription aliases, path suffixes, User-Agent priority, portal
  aliases, and generated URLs in one server-side client format catalog.

## 0.2.27 - 2026-08-24

### Added

- Added a native Loon node subscription to the universal user URL, including
  explicit `format=loon`, Loon User-Agent negotiation, and client links in the
  administrator console and user portal.
- Loon exports compatible Shadowsocks, VMess, VLESS, Trojan, AnyTLS, and
  Hysteria 2 nodes while omitting TUIC and legacy Hysteria nodes that would
  invalidate the subscription.

## 0.2.26 - 2026-08-07

### Changed

- Unified Mihomo and Egern adaptive fallback with server health admission:
  healthy UDP is preferred on suitable networks and automatically falls back
  to TCP, while unhealthy UDP remains available only in explicit UDP/manual
  groups.
- Protocol groups are now emitted only when they contain matching protocols,
  preventing UDP-only subscriptions from exposing a misleading TCP group.
- Local domains, loopback, private networks, link-local ranges, and CGNAT are
  resolved locally and bypass the proxy consistently in Mihomo, Egern, and
  sing-box full configurations.
- Egern smart selection now applies the same TCP stability preference to
  Shadowsocks as the other TCP protocols.

## 0.2.25 - 2026-08-06

### Fixed

- Restored a shared frontend text-update helper so the post-login bootstrap can
  render the routing workspace instead of surfacing `setText is not defined`.
- Added a regression test that executes the real routing-policy renderer used
  immediately after administrator login.

## 0.2.24 - 2026-08-06

### Added

- Added one persisted routing policy with smart split routing, global proxy,
  and direct modes shared by Mihomo, Egern, and sing-box subscriptions.
- Added validated custom domain, domain-suffix, IP, and CIDR rules with
  direct, proxy, AI proxy, block, and DNS behaviors.
- Added an explainable domain-routing diagnostic that reports DNS answers,
  matched policy source, and the selected outbound without pretending to
  measure the user's local network.

### Fixed

- Mihomo now resolves real addresses before its China GeoIP rule, preventing
  Fake-IP answers from forcing China-hosted domains through the proxy.
- DNS behavior now follows the selected routing mode consistently across all
  full client configuration formats.
- Demo data uses durable future expirations so release verification does not
  change as calendar dates pass.

## 0.2.23 - 2026-08-04

### Changed

- Removed the age-based online database backup warning so an older backup that
  still passes its integrity check no longer creates a false operational alert.
- Preserved separate alerts for a missing backup and a backup that fails its
  SQLite integrity check.

## 0.2.22 - 2026-08-04

### Changed

- Removed the standalone Operations workspace and moved Runtime status into
  System Hosts, with publishing, rollback, and Deployment history under
  System maintenance.
- Added Host-scoped diagnostics with refreshable Runtime, protocol,
  Deployment application, and Runtime-eligible User checks.
- Preserved legacy Operations links by redirecting them to the new publishing
  and rollback workspace.

## 0.2.21 - 2026-08-03

### Fixed

- Mihomo smart, fallback and manual policies now expose every eligible enabled
  protocol; the UDP policy also includes Hysteria alongside Hysteria 2 and TUIC.
- Mihomo TLS exports use the protocol-correct SNI field, and TUIC exports include
  bounded heartbeat and connection timeouts.
- Health checks use separate smart, TCP and UDP budgets so unreliable UDP paths
  do not slow TCP failover.

## 0.2.20 - 2026-08-02

### Changed

- Subscription delivery now uses a compact two-column client picker in both
  the administrator drawer and user portal.
- Clash/Mihomo is presented as the recommended import while Egern full-profile
  and node-only imports remain clearly separated.

## 0.2.19 - 2026-08-01

### Fixed

- Online SQLite backups now remove temporary WAL and shared-memory sidecars
  after successful creation.
- The next backup automatically cleans temporary SQLite files left by an
  interrupted previous backup, preventing unbounded backup-directory growth.

## 0.2.18 - 2026-08-01

### Fixed

- Release verification now respects root-owned protocol Runtime artifacts and
  verifies the pinned Cronet companion checksum before protocol acceptance.
- Memory soak checks use a bounded keep-alive client pool, separating server
  memory behavior from Node.js client socket allocation high-water marks.

## 0.2.17 - 2026-07-30

### Added

- Unified routing policy exported consistently to sing-box, Mihomo and Egern.
- Deployment Target status and atomic remote task claiming for multi-Host rollout.
- Owner, Operator, Support and Auditor roles with mutation audit events.
- Online SQLite backup, verified restore tooling and pre-upgrade migration checks.
- Protocol health windows using P50, P95, MAD jitter and TCP/UDP stability admission.
- Webhook alerts for Host, Deployment, protocol, metering, memory, disk, certificate and backup health.
- Native Linux AMD64 and ARM64 release pipelines with SHA-256 manifests, SPDX SBOMs and GitHub build provenance.

### Changed

- RayLink Node telemetry now reports disk capacity in addition to CPU, memory, network and Runtime state.
- Official one-command installation accepts both Linux AMD64 and ARM64 release packages.
- Approved Linux Runtime packages now include the pinned Cronet companion required for real Naive protocol probes, including checksums, rollback and SBOM metadata.
