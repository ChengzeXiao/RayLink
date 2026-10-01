#!/usr/bin/env bash
set -euo pipefail
[ "${RAYLINK_DISPOSABLE_SYSTEM:-}" = 1 ] || { echo 'Requires an explicitly disposable VM' >&2; exit 1; }
[ "$(uname -s)" = Linux ] && [ "$(id -u)" -eq 0 ] || exit 1
[ ! -e /opt/raylink ] && [ ! -e /var/lib/raylink ] || { echo 'Refusing to replace an existing installation' >&2; exit 1; }
archive="$(realpath "$1")"
version="$2"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 1
test_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
temporary_root="$(mktemp -d)"
trap 'rm -rf "$temporary_root"' EXIT
tar -xzf "$archive" -C "$temporary_root"
source_root="$temporary_root/raylink-$version"
RAYLINK_PUBLIC_IP=127.0.0.1 RAYLINK_SOURCE_DIR="$source_root" bash "$source_root/deploy/install-control-plane.sh"
systemctl is-active --quiet raylink caddy sing-box-raylink
[ "$(stat -c %a /etc/raylink/initial-login.json)" = 600 ]
/opt/raylink-nodejs/bin/node "$test_root/linux-installed-api.mjs"

# Exercise the actual running service's mount namespace, not a mocked unit.
runtime_pid="$(systemctl show -p MainPID --value sing-box-raylink)"
nsenter -t "$runtime_pid" -m -- /bin/sh -c '
  touch /var/lib/raylink/acme/release-write-check
  rm /var/lib/raylink/acme/release-write-check
  if ( : >> /var/lib/raylink/sing-box/config.json ) 2>/dev/null; then exit 1; fi
'
runtime_pid="$(systemctl show -p MainPID --value sing-box-raylink)"
credentials_digest="$(sha256sum /etc/raylink/initial-login.json | cut -d" " -f1)"
RAYLINK_FORCE_UPGRADE=true RAYLINK_SOURCE_DIR="$source_root" bash "$source_root/deploy/upgrade-control-plane.sh"
[ "$(systemctl show -p MainPID --value sing-box-raylink)" = "$runtime_pid" ]
[ "$(sha256sum /etc/raylink/initial-login.json | cut -d" " -f1)" = "$credentials_digest" ]
/opt/raylink-nodejs/bin/node "$test_root/linux-installed-api.mjs" --verify-preserved

# Force a post-switch startup failure. The installer must restore the live app/data.
printf 'throw new Error("intentional disposable release rollback check");\n' > "$source_root/server/index.js"
if RAYLINK_FORCE_UPGRADE=true RAYLINK_SOURCE_DIR="$source_root" bash "$source_root/deploy/upgrade-control-plane.sh"; then
  echo 'Broken candidate unexpectedly succeeded' >&2; exit 1
fi
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:4173/api/setup/status >/dev/null; then break; fi
  sleep 1
done
[ "$(systemctl show -p MainPID --value sing-box-raylink)" = "$runtime_pid" ]
/opt/raylink-nodejs/bin/node "$test_root/linux-installed-api.mjs" --verify-preserved
printf 'Native install, HTTPS, user traffic, metering, MCP, sandbox and upgrade rollback passed.\n'
