# Reviewed China routing baseline

The SRS files retain RayLink's previously pinned SagerNet commits, not a claim of today's upstream data. `publishedAt` is this bundle's packaging date. The adjacent manifest records immutable commit URLs, SHA-256, sizes, decoded JSON hashes and classification counts. Sources:

- https://github.com/SagerNet/sing-geosite/tree/a9958574d2c9c8c1f01b726ef9930e0244b10b23
- https://github.com/SagerNet/sing-geoip/tree/5605651c12ed5b2fcf3b5de580c041eb9d8d938e

Original upstream notices are retained as `LICENSE.sing-geosite` and `LICENSE.sing-geoip`; `COPYING` contains GPL version 3. Both upstream projects declare GPL-3.0-or-later. These notices cover the bundled upstream data; the local JavaScript remains governed by the repository's license. JSON files are native sing-box decompilations of the verified SRS files, without pruning exact domains, suffixes, regex or IPv6 CIDRs.

## Updating

1. Prepare a local candidate manifest with a new version/date, reviewed immutable source commit URLs, byte sizes and independently checked SHA-256 values. Never replace these pins with a mutable branch or trust a digest supplied by the same unreviewed online response.
2. Run `SING_BOX_BIN=/path/to/sing-box node server/routing/rule-sets/update.mjs /path/to/candidate-manifest.json /tmp/new-reviewed-rules`. The output directory must not exist. The script verifies checksums, decompiles, checks known CN/non-CN samples and recompiles the exact inline JSON before publishing a complete candidate directory. It never edits the existing baseline.
3. Review the resulting metadata, classification changes and license notices. Copy the two SRS files, two JSON files and manifest into this directory together, and commit them with regression results. Ship all files under `server/routing/rule-sets/`, including notices, in release/container builds.

`ManagedRuleSetCache` also accepts a `manifestPath` to a separately installed, maintainer-approved local manifest. Operators can set `RAYLINK_RULE_SET_MANIFEST=/absolute/path/manifest.json` and restart the application to configure that location. Only changed approved hashes download; no automatic acceptance of unknown upstream versions. Complete generations activate through one atomic pointer replacement. Failed candidates retain the last good generation; cold starts always have this full bundled baseline. Old generations remain on disk for recovery and may be archived by maintenance after checking the active pointer.

Call and await `prepare()` during app startup. `status()` reports active and desired versions, sources, hashes/counts, last check and degradation; it does not claim network freshness. Native matching uses the active snapshot. `getBundledRoutingRules()` loads and validates inline JSON once, returns deeply frozen `{ geosite, geoip }` rule arrays, and starts no subprocess.
