# Reviewed China routing baseline

The bundled domain and IP sets have different sources and freshness dates. `manifest.json` records the exact SHA-256, byte sizes, decoded JSON hashes, classification counts and source metadata. `publishedAt` is the bundle's packaging date, not proof that either upstream source is current.

- Domains remain unchanged at [SagerNet sing-geosite commit a9958574](https://github.com/SagerNet/sing-geosite/tree/a9958574d2c9c8c1f01b726ef9930e0244b10b23). The bundle preserves exact domains, suffixes and regular expressions.
- IPs are derived from [DB-IP IP to Country Lite, October 2026](https://db-ip.com/db/download/ip-to-country-lite), selecting the CSV geographical `country=CN` records. The source contains 710,834 records; the 10,041 selected ranges normalize to 15,365 non-overlapping CIDRs (8,331 IPv4 and 7,034 IPv6). This is geographical classification, not ISP registration, ASN ownership or a provider-wide exception.

The former SagerNet `registered_country` baseline missed geographically Chinese cloud addresses whose ISP registration was overseas. For example, `8.141.181.226` and `8.142.1.1` are CN in both the selected DB-IP source and GeoLite2 Country 2026-09-12's `country.iso_code`, whereas that GeoLite2 edition's `registered_country.iso_code` is SG. The secondary database is only a review cross-check; it is not a source of bundled data.

Geolocation is an estimate. Sources can disagree (for example, `8.128.1.1` is CN in this DB-IP edition and SG in that GeoLite2 edition). It does not establish application identity or guarantee direct reachability. Custom, AI and explicit overseas-domain rules therefore precede this IP fallback. No entire cloud ASN is classified as domestic, and unknown traffic retains the existing manually selectable fallback.

## Source and licenses

[IP Geolocation by DB-IP](https://db-ip.com). `LICENSE.db-ip` and `COPYING.CC-BY-4.0` cover the replacement IP data. RayLink selected CN records, normalized their exact ranges and encoded them as source JSON / native sing-box SRS. DB-IP requires attribution, including a link on web pages displaying or using these results. It does not endorse RayLink.

`LICENSE.sing-geosite` and `COPYING` cover the unchanged GPL-3.0-or-later domain data. The old `LICENSE.sing-geoip` notice is retained for prior-baseline provenance only; it does not license the replacement DB-IP files. The local generator and JavaScript remain governed by the repository's license.

## Reproducing the IP set

`country-source.json` pins the compressed download and uncompressed CSV with byte lengths and SHA-256 values. Its `upstreamSha1` is the uncompressed-file checksum separately published on the official download page. The monthly URL may be replaced upstream; an unreviewed byte change is rejected. Do not infer content immutability from the date in the URL.

Download the pinned `source.url` to a local file, then run:

```sh
python3 server/routing/rule-sets/generate-country.py \
  server/routing/rule-sets/country-source.json \
  /path/to/dbip-country-lite-2026-10.csv.gz \
  /tmp/new-cn-candidate \
  --sing-box /path/to/sing-box
```

Python 3's standard library is sufficient. No network access occurs inside this generator. The output directory must not exist. The generator rejects altered source bytes, inconsistent record counts, malformed or overlapping ranges, and failed CN/non-CN samples. It selects `country=CN` only, preserves foreign holes, retains IPv6, compiles native SRS and decompiles/compiles it again to verify that inline JSON and binary rules are identical.

Outputs are `geoip-cn.srs`, `geoip-cn.json` and `country-review.json`. The report records source pins, compiler version, baseline hash, added/removed coverage and the candidate manifest entry. Its integer address counts are strings so IPv6 precision is not lost. `COUNTRY-REVIEW.md` summarizes the reviewed change. To reproduce that historical difference, supply the previous baseline JSON with `--baseline`; the default compares to the currently installed JSON. This does not affect the generated IP set.

The manifest entry has `delivery: "bundled"` and source provenance rather than a fictitious downloadable SRS URL. The program release contains the generated artifact. A running server validates the bundled candidate and activates it atomically; it never treats the source CSV as an SRS download and never runs Python during subscription generation.

## Updating

1. Prepare a local candidate manifest with a new version/date, reviewed source pins, byte sizes and independently checked SHA-256 values. Keep unchanged sources pinned. Never trust a digest supplied only by an unreviewed response or accept a mutable `latest` link without a checked content digest.
2. Run `SING_BOX_BIN=/path/to/sing-box node server/routing/rule-sets/update.mjs /path/to/candidate-manifest.json /tmp/new-reviewed-rules`. The output directory must not exist. The updater verifies ordinary upstream SRS files; for a generated country set it verifies the pinned source download and invokes the offline country generator. Both paths validate behavior and binary/inline equivalence before producing a complete candidate directory.
3. Review the full country coverage difference, positive domestic and negative foreign/AI samples, source disagreements, licenses and native client tests. Copy the reviewed SRS/JSON pair, manifest, source metadata and review report together. Ship all files under `server/routing/rule-sets/`, including notices, in release/container builds. Do not automatically approve an online dataset change just because it is newer.

`ManagedRuleSetCache` also accepts a `manifestPath` to a separately installed maintainer-approved manifest. Operators can set `RAYLINK_RULE_SET_MANIFEST=/absolute/path/manifest.json` and restart the application. Generated candidates must be installed locally with the approved artifact and source JSON; the running process does not regenerate them. Failed candidates retain the last good generation; cold starts have the complete bundled baseline. Old generations may be removed by maintenance after checking the active pointer.

Await `prepare()` during startup. `status()` reports active/desired versions, sources, hashes/counts, last check and degradation; it does not assert upstream freshness. Native matching uses the active snapshot. `getBundledRoutingRules()` verifies inline JSON once and returns deeply frozen `{ geosite, geoip }` arrays without a subprocess.
