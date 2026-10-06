# Domestic geographical IP fallback

Review baseline: `8325f3d22aeb4d9635da65fdf702af4577cbadde` (v0.2.44 plus acceptance documentation).

## Problem and evidence

A domain absent from the domestic domain list can resolve to a Chinese cloud IP but still enter the unclassified proxy group. The bundled SagerNet GeoIP generator uses `registered_country` (ISP registration), which differs from the destination's geographical country. For example, `8.141.181.226` is in mainland China in the checked geographical datasets, while the previous registration-based set classifies its provider in Singapore. Updating that same registration-based source alone does not correct the classification.

On the affected Mac, `www.intelcupid.com` resolved to this address through remote DNS and reached MATCH / the proxy group. A narrowly scoped production rule for this verified App website corrected its DNS and route. That hotfix does not establish the App's complete API/CDN inventory or solve unknown domestic domains generally.

## Required behavior

1. Use a reviewed, reproducible CN geographical IP dataset for the generic domestic IP fallback. Preserve IPv4 and IPv6, pin immutable sources and hashes, retain their license/attribution, and document additions/removals relative to the old dataset. Do not classify an entire cloud provider or ASN as domestic.
2. Ship consistent binary and inline data for sing-box, Mihomo legacy/modern and Egern full subscriptions. An application update must activate the new verified bundle even if an old cached generation remains, including offline startup. Failed or corrupt downloads retain a complete valid generation.
3. Preserve rule precedence: LAN and user overrides, explicit AI/foreign domains, domestic domains, domestic IP fallback, then the manual unclassified group. A CN IP result must not override an explicit AI/foreign/custom proxy rule. Preserve manual AI node selection and host constraints.
4. Keep domestic DNS paired with verified domestic domains. Do not switch all unknown domains to domestic DNS without validating candidate addresses, introduce success-based automatic DIRECT learning, or broaden shared cloud/CDN domains. Unknown foreign destinations retain the existing unclassified group. The later [domestic DNS selection specification](domestic-dns-selection-spec.md) adds a validated candidate mechanism for Mihomo smart subscriptions.
5. Maintenance validation must include the known geographical/registration mismatch and overseas cloud/CDN negatives, not only familiar public DNS addresses. Native core tests must demonstrate the unknown-domain CN route and precedence protections; distinguish route classification from successful end-to-end requests.
6. Preserve users, entitlements, credentials, usage, existing policy and the live `intelcupid.com` exception during deployment. No database migration or protocol change is required.

## Acceptance boundary

Publish evidence for automated tests, immutable data provenance, release artifacts, server activation and current Mac requests separately. The iPhone App still requires a refreshed full subscription and new phone-side connection records. A Mac probe or simulated native route cannot prove all domestic Apps or mobile networks are fixed. Data remains a reviewed snapshot and can be inaccurate; retain explicit rules and the manual unclassified group for exceptions.
