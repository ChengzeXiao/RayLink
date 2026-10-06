# CN geolocation baseline review — 2026-10-06

Source: [DB-IP Country Lite October 2026](https://db-ip.com/db/download/ip-to-country-lite), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). IP Geolocation by [DB-IP](https://db-ip.com).

The former source selected ISP registration country. This replacement selects the geographical country field and normalizes exactly those CN ranges. The domain baseline is unchanged. The full machine-readable coverage delta is `country-review.json`; it identifies the old JSON SHA-256 `9c5ade468337a9589e55c61fac536d52f951eff4b7eae291ff2af655fcba5161`.

| Coverage | Old | New |
| --- | ---: | ---: |
| Total normalized CIDRs | 7,774 | 15,365 |
| New IPv4 CIDRs | — | 8,331 |
| New IPv6 CIDRs | — | 7,034 |

Coverage differences are set differences, not a textual comparison of prefixes: splitting or joining equivalent CIDRs does not count as changed coverage.

| Difference | CIDRs in difference | Addresses |
| --- | ---: | ---: |
| IPv4 added | 1,940 | 11,530,733 |
| IPv4 removed | 918 | 2,416,704 |
| IPv6 added | 3,397 | 9,569,851,121,891,401,989,662,809,312,461 |
| IPv6 removed | 538 | 4,669,143,448,103,247,438,365,237,182,470 |

Positive samples include `8.141.181.226`, `8.142.1.1`, `114.114.114.114`, `223.5.5.5` and `2400:3200::1`. Negative samples include `8.8.8.8`, `1.1.1.1`, overseas cloud `47.88.0.1`, Cloudflare `104.18.32.7`, Anthropic `160.79.104.10` and `2606:4700:4700::1111`. Source data and native SRS matching are both checked; these sample classifications are not live connectivity measurements.

For the two `8.14x` positive samples, GeoLite2 Country 2026-09-12 independently reports geographical CN while its registration-country field reports SG. DB-IP and GeoLite2 disagree on `8.128.1.1`; this known limitation is recorded rather than concealed. No union of entire provider ASNs is added. Explicit AI, foreign-domain and user rules continue to override the geographical IP fallback.

The published compressed source SHA-256 is `097426b8ddae89157d444a59ac1847e873f7943c32d52becc4371c8b0273af80` (4,491,785 bytes). Decompressed SHA-256 is `53864a68fbfef02c27c717d08d431a6d453e9e00e77d9e8da841d382267fca88` (31,210,433 bytes); its SHA1 matches the checksum on DB-IP's official publication page. The generated SRS SHA-256 is `474a9ead467a995699fccc4e7568b4e3c8cca5dc63eb3d03317a41a4a17a8a39` (56,795 bytes). The inline JSON hash is recorded in `manifest.json`.

Native compiler used for this review: sing-box 1.13.14. Every generated output has a binary→JSON→binary equality check; release acceptance also validates the selected Runtime/client versions. This report establishes data generation/classification evidence only, not iPhone application performance or end-to-end routing acceptance.
