#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'RayLink 首次安装恢复失败：%s\n' "$1" >&2; exit 1; }
private_pending() {
  local pending="$1"
  [ -d "$pending" ] && [ ! -L "$pending" ] && [ -O "$pending" ] \
    && [ "$(stat -c '%a' "$pending" 2>/dev/null || stat -f '%Lp' "$pending")" = 700 ] \
    && [ -f "$pending/owner" ] && [ ! -L "$pending/owner" ] \
    && [ "$(cat "$pending/owner")" = RAYLINK_INITIAL_INSTALL_V1 ]
}
unfinished_database() {
  local data_root="$1" node_root="$2"
  [ -e "$data_root/raylink.db" ] || return 0
  [ -x "$node_root/bin/node" ] || return 1
  "$node_root/bin/node" -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const state = db.prepare("SELECT value FROM settings WHERE key = ?").get("setup_state")?.value;
    db.close();
    if (!["UNINITIALIZED", "SETUP_PENDING", "INITIALIZING"].includes(state)) process.exit(1);
  ' "$data_root/raylink.db"
}

case "${1:-}" in
  pending)
    private_pending "${2:?}"
    if [ "$#" -gt 2 ]; then unfinished_database "${3:?}" "${4:?}"; fi
    ;;
  begin)
    install_root="${2:?}"; data_root="${3:?}"; config_root="${4:?}"
    node_root="${5:?}"; caddy_root="${6:?}"; public_ip="${7:?}"
    pending="$config_root/install-pending"
    if [ -e "$pending" ] || [ -L "$pending" ]; then
      private_pending "$pending" || fail "安装标记不是当前 root 的私有受管目录"
      [ "$(cat "$pending/public-ip")" = "$public_ip" ] || fail "恢复地址与首次安装不一致，请使用原 RAYLINK_PUBLIC_IP"
      unfinished_database "$data_root" "$node_root" \
        || fail "数据库已完成初始化或状态不明，请使用升级入口；不会覆盖账号或数据"
      if [ -e "$caddy_root/Caddyfile" ] || [ -L "$caddy_root/Caddyfile" ]; then
        if [ -L "$caddy_root/Caddyfile" ]; then
          [ "$(readlink "$caddy_root/Caddyfile")" = "$data_root/managed/Caddyfile" ] \
            || fail "Caddy 配置链接不属于本次安装，拒绝覆盖"
        else
          expected="$(dpkg-query -W -f='${Conffiles}\n' caddy 2>/dev/null | awk -v path="$caddy_root/Caddyfile" '$1 == path { print $2 }')" \
            || fail "无法确认 Caddy 默认配置来源，拒绝覆盖"
          [ -n "$expected" ] && [ "$(md5sum "$caddy_root/Caddyfile" | awk '{print $1}')" = "$expected" ] \
            || fail "Caddy 配置已被修改，拒绝覆盖；请先保留并处理现有站点"
        fi
      fi
      printf 'resume\n'
    else
      [ ! -e "$install_root/package.json" ] && [ ! -e "$data_root/raylink.db" ] \
        || fail "检测到现有安装，没有本次安装标记；请使用升级入口"
      if command -v caddy >/dev/null 2>&1 || [ -e "$caddy_root/Caddyfile" ] || [ -L "$caddy_root/Caddyfile" ]; then
        fail "检测到已有 Caddy；为避免覆盖现有站点，请使用全新 VPS 或先迁移现有 Caddy 配置"
      fi
      [ ! -L "$config_root" ] || fail "配置目录不能是符号链接"
      if [ -e "$config_root" ]; then [ -d "$config_root" ] && [ -O "$config_root" ] || fail "配置目录不属于当前 root"; fi
      install -d -m 0700 "$config_root"
      mkdir -m 0700 "$pending"
      printf 'RAYLINK_INITIAL_INSTALL_V1\n' > "$pending/owner"
      printf '%s\n' "$public_ip" > "$pending/public-ip"
      chmod 0600 "$pending/owner" "$pending/public-ip"
      printf 'fresh\n'
    fi
    ;;
  *) fail "未知的安装状态操作" ;;
esac
