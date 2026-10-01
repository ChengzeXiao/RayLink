#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'RayLink Node 更新失败：%s\n' "$1" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "需要 root"
[ "$(uname -s)" = Linux ] || fail "只支持 Linux systemd Host"
RAYLINK_NODE_ROOT="${RAYLINK_NODE_ROOT:-/opt/raylink-node}"
RAYLINK_SERVER="${RAYLINK_SERVER:-}"
printf '%s' "$RAYLINK_SERVER" | grep -Eq '^https://[A-Za-z0-9._:-]+$' \
  || fail "RAYLINK_SERVER 必须是 HTTPS 根地址"
node_binary="$RAYLINK_NODE_ROOT/node/bin/node"
[ -x "$node_binary" ] && [ -f "$RAYLINK_NODE_ROOT/raylink-node.mjs" ] \
  || fail "请先安装并接入 RayLink Node"
command -v curl >/dev/null || fail "需要 curl"
command -v systemctl >/dev/null || fail "需要 systemd"
systemctl is-active --quiet raylink-node.service || fail "Node 服务未运行，请先修复"

candidate_root="$(mktemp -d "$RAYLINK_NODE_ROOT/.upgrade-XXXXXX")"
backup_root="$(mktemp -d "$RAYLINK_NODE_ROOT/backup-XXXXXX")"
switched=false
succeeded=false
builder_existed=false
rollback() {
  status=$?
  trap - EXIT
  if [ "$switched" = true ] && [ "$succeeded" != true ]; then
    systemctl stop raylink-node.service >/dev/null 2>&1 || true
    cp -p "$backup_root/raylink-node.mjs" "$RAYLINK_NODE_ROOT/raylink-node.mjs"
    if [ "$builder_existed" = true ]; then
      cp -p "$backup_root/build-metered-runtime.sh" "$RAYLINK_NODE_ROOT/build-metered-runtime.sh"
    else
      rm -f "$RAYLINK_NODE_ROOT/build-metered-runtime.sh"
    fi
    systemctl start raylink-node.service >/dev/null 2>&1 || true
    printf '已恢复旧 Node 程序；身份、配置和 Runtime 未更改。\n' >&2
  fi
  rm -rf "$candidate_root"
  exit "$status"
}
trap rollback EXIT

for asset in raylink-node.mjs build-metered-runtime.sh; do
  curl -fsSL --connect-timeout 10 --max-time 120 "$RAYLINK_SERVER/node/$asset" -o "$candidate_root/$asset"
  chmod 0755 "$candidate_root/$asset"
done
"$node_binary" --check "$candidate_root/raylink-node.mjs"
bash -n "$candidate_root/build-metered-runtime.sh"
"$node_binary" --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const node = await import(pathToFileURL(process.argv[1]).href);
  if (node.AGENT_VERSION !== "0.8.0") throw new Error("控制面未提供 Node 0.8.0");
' "$candidate_root/raylink-node.mjs"
cp -p "$RAYLINK_NODE_ROOT/raylink-node.mjs" "$backup_root/raylink-node.mjs"
if [ -f "$RAYLINK_NODE_ROOT/build-metered-runtime.sh" ]; then
  cp -p "$RAYLINK_NODE_ROOT/build-metered-runtime.sh" "$backup_root/build-metered-runtime.sh"
  builder_existed=true
fi
# Keep the enrollment state, private keys, active config and Runtime untouched.
switched=true
systemctl stop raylink-node.service
mv -f "$candidate_root/raylink-node.mjs" "$RAYLINK_NODE_ROOT/raylink-node.mjs"
mv -f "$candidate_root/build-metered-runtime.sh" "$RAYLINK_NODE_ROOT/build-metered-runtime.sh"
systemctl start raylink-node.service
for attempt in 1 2; do
  sleep 1
  systemctl is-active --quiet raylink-node.service || fail "新 Node 未通过服务健康检查"
done
succeeded=true
printf 'RayLink Node 已更新为 0.8.0；备份：%s\n' "$backup_root"
printf '等待控制面显示 Node 0.8.0 后，再执行 Runtime 1.14.2 升级。\n'
