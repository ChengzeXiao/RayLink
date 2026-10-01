# RayLink Changelog

## 0.2.33 (unreleased)

- Add a persistent localhost control-plane entry without simulated users or nodes; surface the HTTPS prerequisite before accepting SSH credentials.
- Show disconnected control-plane status, back off read polling and reconnect without replaying writes or clearing SSH onboarding forms; require fresh reads after login and successful writes.
- Initialize the first administrator only when the database has no administrators, preventing renamed credentials from being recreated on restart.

- Add SSH onboarding with durable jobs, pinned host keys, password/key authentication, resumable installation, automatic protocol publication, metering and subscription verification.
- Add MCP Server management over Streamable HTTP with 48 scoped tools and an Owner Bearer Token console; SSH onboarding requires a separately granted hosts.provision scope.
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
- Add Node 0.8.0 program-only updates, preserve the Runtime/Cronet pair during application upgrades, and gate Runtime upgrades on the Node version.
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
