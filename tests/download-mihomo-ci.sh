#!/usr/bin/env bash
# Test client only; never installs or replaces a production Runtime.
set -euo pipefail
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || {
  printf '%s\n' 'This pinned CI client requires Linux x86_64.' >&2
  exit 1
}
mihomo_test_directory="${1:?Provide a temporary test-client directory}"
mkdir -p "$mihomo_test_directory"
curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 180 \
  --output "$mihomo_test_directory/mihomo.gz" \
  'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.25/mihomo-linux-amd64-v1-v1.19.25.gz'
# Digest published by MetaCubeX for release asset 421891534.
printf '%s\n' '156f76302e819fe0cebd1f48d6109e75e1d969f0ef303a4d4bb938b5b4758887  mihomo.gz' \
  | (cd "$mihomo_test_directory" && sha256sum --check -)
gzip --decompress --stdout "$mihomo_test_directory/mihomo.gz" > "$mihomo_test_directory/mihomo"
chmod 0755 "$mihomo_test_directory/mihomo"
"$mihomo_test_directory/mihomo" -v
