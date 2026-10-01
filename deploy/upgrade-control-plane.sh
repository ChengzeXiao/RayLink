#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'RayLink 升级失败：%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "请以 root 运行"
[ "$(uname -s)" = "Linux" ] || fail "当前自动升级仅支持 Linux"
command -v systemctl >/dev/null 2>&1 || fail "当前系统未使用 systemd"
command -v curl >/dev/null 2>&1 || fail "需要 curl"
command -v tar >/dev/null 2>&1 || fail "需要 tar"
command -v sha256sum >/dev/null 2>&1 || fail "需要 sha256sum"

install_root="${RAYLINK_INSTALL_ROOT:-/opt/raylink}"
data_root="${RAYLINK_DATA_ROOT:-/var/lib/raylink}"
backup_root="${RAYLINK_BACKUP_ROOT:-/var/backups/raylink}"
node_root="${RAYLINK_NODE_ROOT:-/opt/raylink-nodejs}"
service_unit="${RAYLINK_SERVICE_UNIT:-/etc/systemd/system/raylink.service}"
environment_file_input="${RAYLINK_ENV_FILE:-/etc/raylink/raylink.env}"
source_root="${RAYLINK_SOURCE_DIR:-}"
health_port="${RAYLINK_PORT:-}"
force_upgrade="${RAYLINK_FORCE_UPGRADE:-false}"
public_ip="${RAYLINK_PUBLIC_IP:-}"
runtime_version=1.14.2
cronet_install_path="${RAYLINK_CRONET_PATH:-/usr/local/bin/libcronet.so}"
cronet_candidate_path="${cronet_install_path}.candidate.$$"
case "$(uname -m)" in
  x86_64|amd64) runtime_arch=amd64 ;;
  aarch64|arm64) runtime_arch=arm64 ;;
  *) fail "不支持的 CPU 架构：$(uname -m)" ;;
esac

[ -f "$install_root/package.json" ] || fail "未检测到现有 RayLink 控制面：$install_root"
[ -x "$node_root/bin/node" ] || fail "未检测到 RayLink Node.js：$node_root/bin/node"
[ -e "$environment_file_input" ] || fail "未检测到 RayLink 环境文件：$environment_file_input"
environment_file="$(readlink -f "$environment_file_input")"
systemctl is-active --quiet raylink || fail "raylink 服务当前未运行，请先修复服务再升级"

existing_local_host_dial_address="$(
  sed -n 's/^[[:space:]]*RAYLINK_LOCAL_HOST_DIAL_ADDRESS=\([^#[:space:]]*\).*$/\1/p' \
    "$environment_file" \
    | tail -1
)"
local_host_dial_address="$existing_local_host_dial_address"
backfill_local_host_dial_address=false
if [ -z "$local_host_dial_address" ]; then
  if [ -z "$public_ip" ]; then
    public_ip="$(
      curl -fsSL --connect-timeout 5 https://api64.ipify.org 2>/dev/null || true
    )"
  fi
  [ -n "$public_ip" ] \
    || fail "无法确定客户端拨号公网 IP，请设置 RAYLINK_PUBLIC_IP 后重试"
  local_host_dial_address="$public_ip"
  backfill_local_host_dial_address=true
fi
"$node_root/bin/node" -e '
  const { isIP } = require("node:net");
  if (!isIP(process.argv[1])) process.exit(1);
' "$local_host_dial_address" \
  || fail "客户端拨号地址不是有效 IP：$local_host_dial_address"

if [ -z "$source_root" ]; then
  script_directory="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  source_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
fi
[ -f "$source_root/package.json" ] || fail "升级包缺少 package.json"
[ -f "$source_root/server/index.js" ] || fail "升级包缺少 server/index.js"
[ -f "$source_root/web/index.html" ] || fail "升级包缺少 web/index.html"
[ -f "$source_root/deploy/raylink.service" ] || fail "升级包缺少 raylink.service"
cronet_source="${RAYLINK_CRONET_SOURCE:-$source_root/web/node/runtime/raylink-libcronet-${runtime_version}-linux-${runtime_arch}.so}"
cronet_checksum="${cronet_source}.sha256"
[ -f "$cronet_source" ] && [ -f "$cronet_checksum" ] \
  || fail "升级包缺少 linux-${runtime_arch} Cronet 依赖或校验文件"
expected_cronet_sha256="$(awk 'NR == 1 { print $1 }' "$cronet_checksum")"
printf '%s' "$expected_cronet_sha256" | grep -Eq '^[a-f0-9]{64}$' \
  || fail "Cronet 校验文件格式错误"
printf '%s  %s\n' "$expected_cronet_sha256" "$cronet_source" | sha256sum -c -
if find "$source_root/package.json" "$source_root/server" "$source_root/web" "$source_root/deploy" \
  -type l -print -quit | grep -q .; then
  fail "升级包不能包含符号链接"
fi

read_version() {
  "$node_root/bin/node" -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version;
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value)) process.exit(1);
    process.stdout.write(value);
  ' "$1"
}

current_version="$(read_version "$install_root/package.json")" \
  || fail "当前版本号无效"
candidate_version="$(read_version "$source_root/package.json")" \
  || fail "升级包版本号无效"

if [ "$current_version" = "$candidate_version" ] && [ "$force_upgrade" != true ]; then
  printf 'RayLink v%s 已是当前版本，无需重复升级。\n' "$current_version"
  exit 0
fi

highest_version="$(printf '%s\n%s\n' "$current_version" "$candidate_version" | sort -V | tail -1)"
if [ "$highest_version" != "$candidate_version" ] && [ "$force_upgrade" != true ]; then
  fail "拒绝从 v$current_version 降级到 v$candidate_version；如确需回退，请设置 RAYLINK_FORCE_UPGRADE=true"
fi

"$node_root/bin/node" --check "$source_root/server/index.js"
"$node_root/bin/node" --check "$source_root/server/app.js"
"$node_root/bin/node" --check "$source_root/server/subscriptions/formats.js"
"$node_root/bin/node" --check "$source_root/server/subscriptions/endpoint-resolver.js"
"$node_root/bin/node" --check "$source_root/web/app.js"

install_parent="$(dirname -- "$install_root")"
install_name="$(basename -- "$install_root")"
install -d -m 0755 "$install_parent"
candidate_parent="$(mktemp -d "$install_parent/.${install_name}-upgrade.XXXXXX")"
candidate_root="$candidate_parent/$install_name"
previous_root="$candidate_parent/${install_name}-previous"
install -d -m 0755 "$candidate_root"

tar -C "$source_root" -cf - package.json server web deploy \
  | tar -C "$candidate_root" -xf -
chown -R root:root "$candidate_root"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_directory="$backup_root/${timestamp}-v${current_version}-to-v${candidate_version}"
install -d -m 0700 "$backup_directory"

switch_started=false
upgrade_succeeded=false
data_backup_ready=false
data_migration_started=false
service_backup_ready=false
cronet_changed=false
cronet_had_previous=false
environment_backup_ready=false
environment_changed=false
environment_candidate_path="${environment_file}.candidate.$$"
rollback() {
  status=$?
  trap - EXIT
  rm -f "$cronet_candidate_path"
  rm -f "$environment_candidate_path"
  if [ "$upgrade_succeeded" != true ]; then
    printf '升级未通过健康检查，正在恢复 RayLink v%s…\n' "$current_version" >&2
    systemctl stop raylink >/dev/null 2>&1 || true
    if [ "$switch_started" = true ] && [ -d "$previous_root" ]; then
      if [ -e "$install_root" ]; then
        mv "$install_root" "$backup_directory/failed-application" 2>/dev/null || true
      fi
      mv "$previous_root" "$install_root"
    fi
    if [ "$data_backup_ready" = true ] && [ "$data_migration_started" = true ]; then
      if [ -e "$data_root" ]; then
        mv "$data_root" "$backup_directory/failed-data" 2>/dev/null || true
      fi
      cp -a "$backup_directory/data" "$data_root"
    fi
    if [ "$service_backup_ready" = true ]; then
      cp -a "$backup_directory/raylink.service" "$service_unit"
    fi
    if [ "$environment_backup_ready" = true ] && [ "$environment_changed" = true ]; then
      cp -a "$backup_directory/raylink.env" "$environment_file"
    fi
    if [ "$cronet_changed" = true ]; then
      if [ "$cronet_had_previous" = true ]; then
        cp -a "$backup_directory/libcronet.so" "$cronet_install_path"
      else
        rm -f "$cronet_install_path"
      fi
    fi
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl start raylink >/dev/null 2>&1 || true
  fi
  rm -rf "$candidate_parent"
  exit "$status"
}
trap rollback EXIT

systemctl stop raylink
if [ -d "$data_root" ]; then
  cp -a "$data_root" "$backup_directory/data"
  data_backup_ready=true
fi
if [ -f "$service_unit" ]; then
  cp -a "$service_unit" "$backup_directory/raylink.service"
  service_backup_ready=true
fi
if [ "$backfill_local_host_dial_address" = true ]; then
  cp -a "$environment_file" "$backup_directory/raylink.env"
  environment_backup_ready=true
  cp -a "$environment_file" "$environment_candidate_path"
  "$node_root/bin/node" -e '
    const fs = require("node:fs");
    const [path, address] = process.argv.slice(1);
    let value = fs.readFileSync(path, "utf8");
    if (value && !value.endsWith("\n")) value += "\n";
    value += `RAYLINK_LOCAL_HOST_DIAL_ADDRESS=${address}\n`;
    fs.writeFileSync(path, value);
  ' "$environment_candidate_path" "$local_host_dial_address"
  mv -f "$environment_candidate_path" "$environment_file"
  environment_changed=true
fi
if [ -f "$cronet_install_path" ]; then
  cp -a "$cronet_install_path" "$backup_directory/libcronet.so"
  cronet_had_previous=true
fi
if [ -f "$backup_directory/data/raylink.db" ]; then
  "$node_root/bin/node" \
    "$candidate_root/deploy/check-database-compatibility.mjs" \
    "$backup_directory/data/raylink.db" \
    || fail "候选版本数据库迁移兼容检查未通过"
fi
mv "$install_root" "$previous_root"
switch_started=true
mv "$candidate_root" "$install_root"
install -m 0644 "$install_root/deploy/raylink.service" "$service_unit"
install -m 0644 "$cronet_source" "$cronet_candidate_path"
mv -f "$cronet_candidate_path" "$cronet_install_path"
cronet_changed=true
systemctl daemon-reload
data_migration_started=true
systemctl start raylink

if [ -z "$health_port" ] && [ -f /etc/raylink/raylink.env ]; then
  health_port="$(
    sed -n 's/^[[:space:]]*RAYLINK_PORT=\([^#[:space:]]*\).*$/\1/p' \
      /etc/raylink/raylink.env \
      | tail -1
  )"
fi
health_port="${health_port:-4173}"
printf '%s' "$health_port" | grep -Eq '^[0-9]{1,5}$' \
  || fail "健康检查端口无效：$health_port"

health_ready=false
for attempt in $(seq 1 30); do
  if systemctl is-active --quiet raylink \
    && curl -fsS --max-time 2 "http://127.0.0.1:${health_port}/api/setup/status" \
      | "$node_root/bin/node" -e '
          let body = "";
          process.stdin.on("data", (chunk) => { body += chunk; });
          process.stdin.on("end", () => {
            const value = JSON.parse(body);
            if (!value || typeof value !== "object") process.exit(1);
          });
        ' >/dev/null 2>&1; then
    health_ready=true
    break
  fi
  sleep 1
done
[ "$health_ready" = true ] || fail "新控制面在 30 秒内未通过本机健康检查"

mv "$previous_root" "$backup_directory/application"
upgrade_succeeded=true
printf 'RayLink 已从 v%s 升级到 v%s。\n' "$current_version" "$candidate_version"
printf '升级前应用和数据备份：%s\n' "$backup_directory"
