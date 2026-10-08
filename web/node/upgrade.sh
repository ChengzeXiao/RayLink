#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'RayLink Node 更新失败：%s\n' "$1" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "需要 root"
[ "$(uname -s)" = Linux ] || fail "只支持 Linux systemd Host"
RAYLINK_NODE_ROOT="${RAYLINK_NODE_ROOT:-/opt/raylink-node}"
RAYLINK_NODE_CONFIG_ROOT="${RAYLINK_NODE_CONFIG_ROOT:-/etc/raylink-node}"
RAYLINK_SYSCTL_ROOT="${RAYLINK_SYSCTL_ROOT:-/etc/sysctl.d}"
RAYLINK_SERVER="${RAYLINK_SERVER:-}"
RAYLINK_CONTROL_CA_FILE="${RAYLINK_CONTROL_CA_FILE:-}"
printf '%s' "$RAYLINK_SERVER" | grep -Eq '^https://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])(:[0-9]+)?$' \
  || fail "RAYLINK_SERVER 必须是 HTTPS 根地址"
for managed_path in "$RAYLINK_NODE_ROOT" "$RAYLINK_NODE_CONFIG_ROOT" "$RAYLINK_SYSCTL_ROOT"; do
  printf '%s' "$managed_path" | grep -Eq '^/[A-Za-z0-9_./-]+$' || fail "受管目录必须为不含空白的绝对路径"
done
node_binary="$RAYLINK_NODE_ROOT/node/bin/node"
[ -x "$node_binary" ] && [ -f "$RAYLINK_NODE_ROOT/raylink-node.mjs" ] \
  || fail "请先安装并接入 RayLink Node"
command -v curl >/dev/null || fail "需要 curl"
command -v systemctl >/dev/null || fail "需要 systemd"
systemctl is-active --quiet raylink-node.service || fail "Node 服务未运行，请先修复"
node_environment="$RAYLINK_NODE_CONFIG_ROOT/node.env"
persisted_ca="$RAYLINK_NODE_CONFIG_ROOT/control-plane-ca.pem"
if [ -z "$RAYLINK_CONTROL_CA_FILE" ] && [ -f "$node_environment" ]; then
  RAYLINK_CONTROL_CA_FILE="$(awk -F= '$1 == "RAYLINK_CONTROL_CA_FILE" { count++; value=substr($0, index($0,"=")+1) } END { if (count == 1) print value }' "$node_environment")"
fi
if [ -z "$RAYLINK_CONTROL_CA_FILE" ] && [ -s "$persisted_ca" ]; then RAYLINK_CONTROL_CA_FILE="$persisted_ca"; fi
ca_arguments=(--tlsv1.2)
if [ -n "$RAYLINK_CONTROL_CA_FILE" ]; then
  [ -f "$RAYLINK_CONTROL_CA_FILE" ] && [ -r "$RAYLINK_CONTROL_CA_FILE" ] && [ -s "$RAYLINK_CONTROL_CA_FILE" ] \
    || fail "控制面 CA 文件不可读取"
  [ -f "$node_environment" ] || fail "缺少节点服务环境，无法保存控制面信任配置"
  ca_arguments+=(--cacert "$RAYLINK_CONTROL_CA_FILE")
fi

candidate_root="$(mktemp -d "$RAYLINK_NODE_ROOT/.upgrade-XXXXXX")"
backup_root="$(mktemp -d "$RAYLINK_NODE_ROOT/backup-XXXXXX")"
switched=false
succeeded=false
bbr_link="$RAYLINK_SYSCTL_ROOT/99-raylink-node-bbr.conf"
bbr_link_changed=false
trust_changed=false
rollback() {
  status=$?
  trap - EXIT
  if [ "$switched" = true ] && [ "$succeeded" != true ]; then
    systemctl stop raylink-node.service >/dev/null 2>&1 || true
    cp -p "$backup_root/raylink-node.mjs" "$RAYLINK_NODE_ROOT/raylink-node.mjs"
    for asset in build-metered-runtime.sh network-tuning.mjs software-update.mjs; do
      if [ -f "$backup_root/$asset" ]; then
        cp -p "$backup_root/$asset" "$RAYLINK_NODE_ROOT/$asset"
      else
        rm -f "$RAYLINK_NODE_ROOT/$asset"
      fi
    done
  fi
  if [ "$trust_changed" = true ] && [ "$succeeded" != true ]; then
    cp -p "$backup_root/node.env" "$node_environment"
    if [ -f "$backup_root/control-plane-ca.pem" ]; then
      cp -p "$backup_root/control-plane-ca.pem" "$persisted_ca"
    else rm -f "$persisted_ca"; fi
  fi
  if [ "$switched" = true ] && [ "$succeeded" != true ]; then
    systemctl start raylink-node.service >/dev/null 2>&1 || true
    printf '已恢复旧 Node 程序；身份、配置和 Runtime 未更改。\n' >&2
  fi
  if [ "$bbr_link_changed" = true ] && [ "$succeeded" != true ]; then
    rm -f "$bbr_link"
    if [ -e "$backup_root/bbr-link" ] || [ -L "$backup_root/bbr-link" ]; then
      cp -Pp "$backup_root/bbr-link" "$bbr_link"
    fi
  fi
  rm -rf "$candidate_root"
  exit "$status"
}
trap rollback EXIT

for asset in raylink-node.mjs build-metered-runtime.sh network-tuning.mjs software-update.mjs; do
  curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 \
    --retry 2 --retry-delay 1 --retry-max-time 300 "${ca_arguments[@]}" "$RAYLINK_SERVER/node/$asset" -o "$candidate_root/$asset"
  chmod 0755 "$candidate_root/$asset"
done
"$node_binary" --check "$candidate_root/raylink-node.mjs"
"$node_binary" --check "$candidate_root/network-tuning.mjs"
"$node_binary" --check "$candidate_root/software-update.mjs"
bash -n "$candidate_root/build-metered-runtime.sh"
RAYLINK_VERIFY_MODULE="$candidate_root/raylink-node.mjs" "$node_binary" --input-type=module -e '
  import { pathToFileURL } from "node:url";
  // Keep argv[1] empty: importing a program must not trigger its CLI main guard.
  const node = await import(pathToFileURL(process.env.RAYLINK_VERIFY_MODULE).href);
  if (node.AGENT_VERSION !== "0.9.2") throw new Error("控制面未提供 Node 0.9.2");
'
cp -p "$RAYLINK_NODE_ROOT/raylink-node.mjs" "$backup_root/raylink-node.mjs"
for asset in build-metered-runtime.sh network-tuning.mjs software-update.mjs; do
  if [ -f "$RAYLINK_NODE_ROOT/$asset" ]; then cp -p "$RAYLINK_NODE_ROOT/$asset" "$backup_root/$asset"; fi
done
if [ -n "$RAYLINK_CONTROL_CA_FILE" ]; then
  cp -p "$node_environment" "$backup_root/node.env"
  if [ -f "$persisted_ca" ]; then cp -p "$persisted_ca" "$backup_root/control-plane-ca.pem"; fi
  install -m 0644 "$RAYLINK_CONTROL_CA_FILE" "$candidate_root/control-plane-ca.pem"
  awk '!/^(NODE_EXTRA_CA_CERTS|RAYLINK_CONTROL_CA_FILE)=/' "$node_environment" > "$candidate_root/node.env"
  {
    printf 'NODE_EXTRA_CA_CERTS=%s\n' "$persisted_ca"
    printf 'RAYLINK_CONTROL_CA_FILE=%s\n' "$persisted_ca"
  } >> "$candidate_root/node.env"
  chmod 0600 "$candidate_root/node.env"
fi
install -d -m 0700 "$RAYLINK_NODE_CONFIG_ROOT"
install -d -m 0755 "$RAYLINK_SYSCTL_ROOT"
if [ -e "$bbr_link" ] || [ -L "$bbr_link" ]; then cp -Pp "$bbr_link" "$backup_root/bbr-link"; fi
bbr_link_changed=true
ln -sfn "$RAYLINK_NODE_CONFIG_ROOT/99-raylink-bbr.conf" "$bbr_link"
# Keep the enrollment state, private keys, active config and Runtime untouched.
switched=true
systemctl stop raylink-node.service
if [ -n "$RAYLINK_CONTROL_CA_FILE" ]; then
  trust_changed=true
  mv -f "$candidate_root/control-plane-ca.pem" "$persisted_ca"
  mv -f "$candidate_root/node.env" "$node_environment"
fi
mv -f "$candidate_root/raylink-node.mjs" "$RAYLINK_NODE_ROOT/raylink-node.mjs"
mv -f "$candidate_root/build-metered-runtime.sh" "$RAYLINK_NODE_ROOT/build-metered-runtime.sh"
mv -f "$candidate_root/network-tuning.mjs" "$RAYLINK_NODE_ROOT/network-tuning.mjs"
mv -f "$candidate_root/software-update.mjs" "$RAYLINK_NODE_ROOT/software-update.mjs"
systemctl start raylink-node.service
for attempt in 1 2; do
  sleep 1
  systemctl is-active --quiet raylink-node.service || fail "新 Node 未通过服务健康检查"
done
succeeded=true
printf 'RayLink Node 已更新为 0.9.2；备份：%s\n' "$backup_root"
printf 'BBR 将自动配置并由心跳上报真实状态；等待控制面显示 Node 0.9.2。\n'
