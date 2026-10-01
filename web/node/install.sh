#!/usr/bin/env bash
set -euo pipefail

RAYLINK_SERVER="${RAYLINK_SERVER:-}"
RAYLINK_ENROLL_TOKEN="${RAYLINK_ENROLL_TOKEN:-}"
RAYLINK_NODE_ROOT="${RAYLINK_NODE_ROOT:-/opt/raylink-node}"
RAYLINK_NODE_VERSION="${RAYLINK_NODE_VERSION:-22}"
RAYLINK_PROTOCOL_PROBE_URL="${RAYLINK_PROTOCOL_PROBE_URL:-https://www.gstatic.com/generate_204}"
SING_BOX_VERSION="${SING_BOX_VERSION:-1.14.2}"
RAYLINK_ENABLE_USER_METERING="${RAYLINK_ENABLE_USER_METERING:-true}"

fail() {
  printf 'RayLink Node 安装失败：%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "请通过 sudo 运行安装命令"
[ "$(uname -s)" = "Linux" ] || fail "当前一键安装仅支持 Linux VPS"
[ -n "$RAYLINK_SERVER" ] || fail "缺少 RAYLINK_SERVER"
[ -n "$RAYLINK_ENROLL_TOKEN" ] || fail "缺少 RAYLINK_ENROLL_TOKEN"
if ! printf '%s' "$RAYLINK_SERVER" | grep -Eq '^https://[A-Za-z0-9._:-]+$'; then
  if [ "${RAYLINK_ALLOW_INSECURE_HTTP:-false}" != "true" ] \
    || ! printf '%s' "$RAYLINK_SERVER" | grep -Eq '^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?$'; then
    fail "RAYLINK_SERVER 生产环境必须是 HTTPS 根地址"
  fi
fi
printf '%s' "$RAYLINK_ENROLL_TOKEN" | grep -Eq '^[A-Za-z0-9_-]{20,256}$' || fail "接入令牌格式无效"
printf '%s' "$RAYLINK_PROTOCOL_PROBE_URL" | grep -Eq '^https://[^[:space:]]+$' \
  || fail "RAYLINK_PROTOCOL_PROBE_URL 必须是 HTTPS 地址"
command -v curl >/dev/null 2>&1 || fail "需要 curl"
command -v tar >/dev/null 2>&1 || fail "需要 tar"
command -v systemctl >/dev/null 2>&1 || fail "需要 systemd"
if ! command -v ss >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y iproute2
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y iproute
  elif command -v yum >/dev/null 2>&1; then
    yum install -y iproute
  else
    fail "端口探测需要 iproute2（ss），当前系统无法自动安装"
  fi
fi

if systemctl list-unit-files sing-box.service >/dev/null 2>&1 \
  && systemctl is-active --quiet sing-box.service; then
  fail "检测到现有 sing-box.service 正在运行；为避免业务中断，请先迁移或停止现有服务后重试"
fi

machine_arch="$(uname -m)"
case "$machine_arch" in
  x86_64|amd64) node_arch="x64"; runtime_arch="amd64" ;;
  aarch64|arm64) node_arch="arm64"; runtime_arch="arm64" ;;
  *) fail "暂不支持 CPU 架构：$machine_arch" ;;
esac

install -d -m 0755 "$RAYLINK_NODE_ROOT"
install -d -m 0700 /etc/raylink-node
install -d -m 0750 /var/lib/raylink-node/sing-box
install -d -m 0755 /etc/tmpfiles.d
curl -fsSL "$RAYLINK_SERVER/node/raylink-ufw.tmpfiles.conf" \
  -o /etc/tmpfiles.d/raylink-node-ufw.conf
chmod 0644 /etc/tmpfiles.d/raylink-node-ufw.conf
systemd-tmpfiles --create /etc/tmpfiles.d/raylink-node-ufw.conf
temporary_root="$(mktemp -d)"
trap 'rm -rf "$temporary_root"' EXIT

if [ ! -x "$RAYLINK_NODE_ROOT/node/bin/node" ]; then
  node_dist_url="https://nodejs.org/dist/latest-v${RAYLINK_NODE_VERSION}.x"
  node_archive="$(curl -fsSL "$node_dist_url/SHASUMS256.txt" | awk -v arch="$node_arch" '$2 ~ ("linux-" arch "\\.tar\\.xz$") { print $2; exit }')"
  [ -n "$node_archive" ] || fail "无法解析 Node.js v${RAYLINK_NODE_VERSION} 安装包"
  curl -fsSL "$node_dist_url/$node_archive" -o "$temporary_root/$node_archive"
  curl -fsSL "$node_dist_url/SHASUMS256.txt" -o "$temporary_root/SHASUMS256.txt"
  (
    cd "$temporary_root"
    grep "  $node_archive\$" SHASUMS256.txt | sha256sum -c -
  )
  rm -rf "$RAYLINK_NODE_ROOT/node"
  mkdir -p "$RAYLINK_NODE_ROOT/node"
  tar -xJf "$temporary_root/$node_archive" -C "$RAYLINK_NODE_ROOT/node" --strip-components=1
fi

curl -fsSL "$RAYLINK_SERVER/node/raylink-node.mjs" -o "$RAYLINK_NODE_ROOT/raylink-node.mjs"
chmod 0755 "$RAYLINK_NODE_ROOT/raylink-node.mjs"

if [ "$RAYLINK_ENABLE_USER_METERING" != "true" ]; then
  fail "正式版 RayLink Node 必须启用真实用户计量"
fi

runtime_name="raylink-sing-box-${SING_BOX_VERSION}-linux-${runtime_arch}"
runtime_url="$RAYLINK_SERVER/node/runtime/$runtime_name"
runtime_candidate="$temporary_root/$runtime_name"
runtime_checksum="$temporary_root/${runtime_name}.sha256"
cronet_name="raylink-libcronet-${SING_BOX_VERSION}-linux-${runtime_arch}.so"
cronet_url="$RAYLINK_SERVER/node/runtime/$cronet_name"
cronet_candidate="$temporary_root/$cronet_name"
cronet_checksum="$temporary_root/${cronet_name}.sha256"
if curl -fsSL "$runtime_url" -o "$runtime_candidate" \
  && curl -fsSL "${runtime_url}.sha256" -o "$runtime_checksum" \
  && curl -fsSL "$cronet_url" -o "$cronet_candidate" \
  && curl -fsSL "${cronet_url}.sha256" -o "$cronet_checksum"; then
  expected_runtime_sha256="$(awk 'NR == 1 { print $1 }' "$runtime_checksum")"
  printf '%s' "$expected_runtime_sha256" | grep -Eq '^[a-f0-9]{64}$' \
    || fail "预编译 Runtime 校验文件格式错误"
  printf '%s  %s\n' "$expected_runtime_sha256" "$runtime_candidate" | sha256sum -c -
  expected_cronet_sha256="$(awk 'NR == 1 { print $1 }' "$cronet_checksum")"
  printf '%s' "$expected_cronet_sha256" | grep -Eq '^[a-f0-9]{64}$' \
    || fail "预编译 Cronet 校验文件格式错误"
  printf '%s  %s\n' "$expected_cronet_sha256" "$cronet_candidate" | sha256sum -c -
  chmod 0755 "$runtime_candidate"
  runtime_details="$("$runtime_candidate" version)" \
    || fail "预编译 Runtime 无法执行"
  printf '%s\n' "$runtime_details" | grep -q "sing-box version ${SING_BOX_VERSION}" \
    || fail "预编译 Runtime 版本不匹配"
  runtime_tags="$(printf '%s\n' "$runtime_details" | sed -n 's/^Tags:[[:space:]]*//p' | tr -d '[:space:]')"
  required_runtime_tags="with_gvisor with_quic with_dhcp with_wireguard with_utls with_acme with_clash_api with_tailscale with_ccm with_ocm with_naive_outbound with_v2ray_api with_purego badlinkname tfogo_checklinkname0"
  for required_runtime_tag in $required_runtime_tags; do
    printf ',%s,' "$runtime_tags" | grep -Fq ",${required_runtime_tag}," \
      || fail "预编译 Runtime 缺少 ${required_runtime_tag}"
  done
  install -m 0644 "$cronet_candidate" /usr/local/bin/libcronet.so
  install -m 0755 "$runtime_candidate" /usr/local/bin/raylink-sing-box
  printf '已安装预编译 RayLink Runtime（linux-%s）\n' "$runtime_arch"
else
  printf '控制台未提供完整 linux-%s 预编译 Runtime，回退到本机编译\n' "$runtime_arch"
  curl -fsSL "$RAYLINK_SERVER/node/build-metered-runtime.sh" \
    -o "$RAYLINK_NODE_ROOT/build-metered-runtime.sh"
  chmod 0755 "$RAYLINK_NODE_ROOT/build-metered-runtime.sh"
  "$RAYLINK_NODE_ROOT/build-metered-runtime.sh" "$SING_BOX_VERSION" \
    /usr/local/bin/raylink-sing-box
fi
sing_box_bin=/usr/local/bin/raylink-sing-box

# The official package can enable its own runtime unit. RayLink owns the
# configuration lifecycle, so keep exactly one sing-box service active.
if systemctl list-unit-files sing-box.service >/dev/null 2>&1; then
  if systemctl is-active --quiet sing-box.service; then
    fail "官方安装过程启动了 sing-box.service；为避免服务冲突，已停止后续接管，请检查现有配置"
  fi
  systemctl disable sing-box.service >/dev/null 2>&1 || true
fi

{
  printf 'RAYLINK_SERVER=%s\n' "$RAYLINK_SERVER"
  printf 'RAYLINK_ENROLL_TOKEN=%s\n' "$RAYLINK_ENROLL_TOKEN"
  printf 'RAYLINK_NODE_STATE=/etc/raylink-node/node.json\n'
  printf 'RAYLINK_NODE_DATA=/var/lib/raylink-node/sing-box\n'
  printf 'RAYLINK_RUNTIME_MODE=systemd\n'
  printf 'RAYLINK_PROTOCOL_PROBE_URL=%s\n' "$RAYLINK_PROTOCOL_PROBE_URL"
  printf 'RAYLINK_ENABLE_USER_METERING=%s\n' "$RAYLINK_ENABLE_USER_METERING"
  printf 'SING_BOX_BIN=%s\n' "$sing_box_bin"
  printf 'SING_BOX_SYSTEMD_UNIT=raylink-sing-box.service\n'
} > /etc/raylink-node/node.env
chmod 0600 /etc/raylink-node/node.env

cat > /etc/systemd/system/raylink-sing-box.service <<EOF
[Unit]
Description=RayLink managed sing-box runtime
After=network-online.target systemd-tmpfiles-setup.service
Wants=network-online.target
ConditionPathExists=/var/lib/raylink-node/sing-box/config.json

[Service]
Type=simple
ExecStart=$sing_box_bin run -c /var/lib/raylink-node/sing-box/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/raylink-node/sing-box

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/raylink-node.service <<EOF
[Unit]
Description=RayLink Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/raylink-node/node.env
ExecStart=$RAYLINK_NODE_ROOT/node/bin/node $RAYLINK_NODE_ROOT/raylink-node.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/etc/raylink-node /var/lib/raylink-node /opt/raylink-node /usr/local/bin -/run/ufw.lock -/run/xtables.lock -/etc/ufw/user.rules -/etc/ufw/user6.rules

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable raylink-sing-box.service
systemctl enable --now raylink-node.service

printf '\nRayLink Node 已安装并启动。\n'
printf '节点状态：systemctl status raylink-node --no-pager\n'
printf '节点日志：journalctl -u raylink-node -f\n'
