#!/usr/bin/env bash
set -euo pipefail

RAYLINK_SERVER="${RAYLINK_SERVER:-}"
RAYLINK_ENROLL_TOKEN="${RAYLINK_ENROLL_TOKEN:-}"
RAYLINK_NODE_ROOT="${RAYLINK_NODE_ROOT:-/opt/raylink-node}"
RAYLINK_NODE_CONFIG_ROOT="${RAYLINK_NODE_CONFIG_ROOT:-/etc/raylink-node}"
RAYLINK_NODE_DATA_ROOT="${RAYLINK_NODE_DATA_ROOT:-/var/lib/raylink-node/sing-box}"
RAYLINK_SYSTEMD_ROOT="${RAYLINK_SYSTEMD_ROOT:-/etc/systemd/system}"
RAYLINK_TMPFILES_ROOT="${RAYLINK_TMPFILES_ROOT:-/etc/tmpfiles.d}"
RAYLINK_SYSCTL_ROOT="${RAYLINK_SYSCTL_ROOT:-/etc/sysctl.d}"
RAYLINK_RUNTIME_BIN_DIR="${RAYLINK_RUNTIME_BIN_DIR:-/usr/local/bin}"
RAYLINK_EXPECT_HOST_ID="${RAYLINK_EXPECT_HOST_ID:-}"
RAYLINK_NODE_VERSION="${RAYLINK_NODE_VERSION:-22}"
RAYLINK_PROTOCOL_PROBE_URL="${RAYLINK_PROTOCOL_PROBE_URL:-https://www.gstatic.com/generate_204}"
SING_BOX_VERSION="${SING_BOX_VERSION:-1.14.2}"
RAYLINK_ENABLE_USER_METERING="${RAYLINK_ENABLE_USER_METERING:-true}"
RAYLINK_CONTROL_CA_FILE="${RAYLINK_CONTROL_CA_FILE:-}"

fail() {
  printf 'RayLink Node 安装失败：%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "请通过 sudo 运行安装命令"
[ "$(uname -s)" = "Linux" ] || fail "当前一键安装仅支持 Linux VPS"
[ -n "$RAYLINK_SERVER" ] || fail "缺少 RAYLINK_SERVER"
if ! printf '%s' "$RAYLINK_SERVER" | grep -Eq '^https://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])(:[0-9]+)?$'; then
  if [ "${RAYLINK_ALLOW_INSECURE_HTTP:-false}" != "true" ] \
    || ! printf '%s' "$RAYLINK_SERVER" | grep -Eq '^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?$'; then
    fail "RAYLINK_SERVER 生产环境必须是 HTTPS 根地址"
  fi
fi
for managed_path in "$RAYLINK_NODE_ROOT" "$RAYLINK_NODE_CONFIG_ROOT" "$RAYLINK_NODE_DATA_ROOT" "$RAYLINK_SYSTEMD_ROOT" "$RAYLINK_TMPFILES_ROOT" "$RAYLINK_SYSCTL_ROOT" "$RAYLINK_RUNTIME_BIN_DIR"; do
  printf '%s' "$managed_path" | grep -Eq '^/[A-Za-z0-9_./-]+$' || fail "受管目录必须为不含空白的绝对路径"
done
if [ -n "$RAYLINK_EXPECT_HOST_ID" ]; then
  printf '%s' "$RAYLINK_EXPECT_HOST_ID" | grep -Eq '^[A-Za-z0-9_-]{1,128}$' || fail "预期主机编号格式无效"
fi
node_environment="$RAYLINK_NODE_CONFIG_ROOT/node.env"
node_state="$RAYLINK_NODE_CONFIG_ROOT/node.json"
sing_box_bin="$RAYLINK_RUNTIME_BIN_DIR/raylink-sing-box"
has_existing_environment=false
read_environment_value() {
  # Never execute an existing environment file as shell code.
  awk -v key="$1" 'index($0, key "=") == 1 { count++; value=substr($0, length(key)+2) }
    END { if (count != 1) exit 1; print value }' "$node_environment"
}
control_plane_trust_changed=false
repair_control_plane_trust() {
  [ -n "$RAYLINK_CONTROL_CA_FILE" ] || return 0
  [ -f "$RAYLINK_CONTROL_CA_FILE" ] && [ -r "$RAYLINK_CONTROL_CA_FILE" ] && [ -s "$RAYLINK_CONTROL_CA_FILE" ] \
    || fail "控制面 CA 文件不可读取"
  local persisted_ca="$RAYLINK_NODE_CONFIG_ROOT/control-plane-ca.pem"
  if cmp -s "$RAYLINK_CONTROL_CA_FILE" "$persisted_ca" \
    && [ "$(read_environment_value NODE_EXTRA_CA_CERTS || true)" = "$persisted_ca" ] \
    && [ "$(read_environment_value RAYLINK_CONTROL_CA_FILE || true)" = "$persisted_ca" ]; then return 0; fi
  local ca_candidate="${persisted_ca}.install-$$"
  local environment_candidate="${node_environment}.install-$$"
  install -m 0644 "$RAYLINK_CONTROL_CA_FILE" "$ca_candidate"
  install -m 0600 /dev/null "$environment_candidate"
  awk '!/^(NODE_EXTRA_CA_CERTS|RAYLINK_CONTROL_CA_FILE)=/' "$node_environment" > "$environment_candidate"
  {
    printf 'NODE_EXTRA_CA_CERTS=%s\n' "$persisted_ca"
    printf 'RAYLINK_CONTROL_CA_FILE=%s\n' "$persisted_ca"
  } >> "$environment_candidate"
  chmod 0600 "$environment_candidate"
  mv -f "$ca_candidate" "$persisted_ca"
  mv -f "$environment_candidate" "$node_environment"
  control_plane_trust_changed=true
}
command -v systemctl >/dev/null 2>&1 || fail "需要 systemd"
if [ -e "$node_environment" ] || [ -e "$node_state" ]; then
  [ -f "$node_environment" ] || fail "现有节点缺少服务端绑定，拒绝覆盖未知安装"
  existing_server="$(read_environment_value RAYLINK_SERVER)" || fail "现有节点服务端绑定无效"
  [ "$existing_server" = "$RAYLINK_SERVER" ] || fail "现有节点属于其他服务端，拒绝覆盖"
  existing_state_path="$(read_environment_value RAYLINK_NODE_STATE)" || fail "现有节点状态路径无法确认，拒绝覆盖"
  [ "$existing_state_path" = "$node_state" ] || fail "现有节点状态路径与目标不符，拒绝覆盖"
  if [ -e "$node_state" ]; then
    identity_node="$RAYLINK_NODE_ROOT/node/bin/node"
    [ -x "$identity_node" ] || fail "缺少现有 Node.js，无法安全确认节点身份"
    existing_host="$("$identity_node" -e '
      const state = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (typeof state.hostId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(state.hostId)
        || typeof state.nodeSecret !== "string" || !state.nodeSecret) process.exit(1);
      process.stdout.write(state.hostId);
    ' "$node_state" 2>/dev/null)" || fail "现有节点身份无法确认，拒绝覆盖"
    [ -z "$RAYLINK_EXPECT_HOST_ID" ] || [ "$existing_host" = "$RAYLINK_EXPECT_HOST_ID" ] \
      || fail "现有节点主机编号与预期不符，拒绝覆盖"
    repair_control_plane_trust
    if [ "$control_plane_trust_changed" = true ]; then
      systemctl enable raylink-node.service
      systemctl restart raylink-node.service
    elif ! systemctl is-active --quiet raylink-node.service; then
      systemctl enable raylink-node.service
      systemctl start raylink-node.service
    fi
    printf 'RayLink Node 已接入当前服务端（Host %s），保留现有凭据、程序与 Runtime。\n' "$existing_host"
    exit 0
  fi
  existing_expected_host="$(read_environment_value RAYLINK_EXPECT_HOST_ID)" || fail "待接入安装缺少预期主机绑定，拒绝覆盖"
  [ -n "$RAYLINK_EXPECT_HOST_ID" ] && [ "$existing_expected_host" = "$RAYLINK_EXPECT_HOST_ID" ] \
    || fail "待接入安装主机编号与预期不符，拒绝覆盖"
  has_existing_environment=true
  if systemctl is-active --quiet raylink-sing-box.service; then
    fail "Runtime 正在运行但节点身份缺失，拒绝接管"
  fi
  repair_control_plane_trust
  if [ -x "$RAYLINK_NODE_ROOT/node/bin/node" ] && [ -f "$RAYLINK_NODE_ROOT/raylink-node.mjs" ] \
    && [ -f "$RAYLINK_SYSTEMD_ROOT/raylink-node.service" ] \
    && [ -f "$RAYLINK_SYSTEMD_ROOT/raylink-sing-box.service" ] && [ -x "$sing_box_bin" ] \
    && RAYLINK_VERIFY_MODULE="$RAYLINK_NODE_ROOT/raylink-node.mjs" "$RAYLINK_NODE_ROOT/node/bin/node" --input-type=module \
      -e 'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.env.RAYLINK_VERIFY_MODULE).href);' 2>/dev/null; then
    systemctl enable raylink-node.service
    if [ "$control_plane_trust_changed" = true ]; then systemctl restart raylink-node.service
    elif ! systemctl is-active --quiet raylink-node.service; then systemctl start raylink-node.service; fi
    printf 'RayLink Node 已安装，继续等待原接入请求；保留原令牌和 Runtime。\n'
    exit 0
  fi
else
  if [ -e "$RAYLINK_NODE_ROOT/raylink-node.mjs" ] || [ -e "$RAYLINK_NODE_DATA_ROOT/config.json" ] \
    || [ -e "$sing_box_bin" ] || [ -e "$RAYLINK_SYSTEMD_ROOT/raylink-node.service" ] \
    || [ -e "$RAYLINK_SYSTEMD_ROOT/raylink-sing-box.service" ] \
    || systemctl is-active --quiet raylink-node.service \
    || systemctl is-active --quiet raylink-sing-box.service; then
    fail "检测到未绑定的现有安装，拒绝覆盖"
  fi
fi
[ -n "$RAYLINK_ENROLL_TOKEN" ] || [ "$has_existing_environment" = true ] || fail "缺少 RAYLINK_ENROLL_TOKEN"
if [ -z "$RAYLINK_CONTROL_CA_FILE" ] && [ -f "$node_environment" ]; then
  RAYLINK_CONTROL_CA_FILE="$(read_environment_value RAYLINK_CONTROL_CA_FILE || true)"
fi
if [ -z "$RAYLINK_CONTROL_CA_FILE" ] && [ -s "$RAYLINK_NODE_CONFIG_ROOT/control-plane-ca.pem" ]; then
  RAYLINK_CONTROL_CA_FILE="$RAYLINK_NODE_CONFIG_ROOT/control-plane-ca.pem"
fi
if [ -n "$RAYLINK_CONTROL_CA_FILE" ]; then
  [ -f "$RAYLINK_CONTROL_CA_FILE" ] && [ -r "$RAYLINK_CONTROL_CA_FILE" ] && [ -s "$RAYLINK_CONTROL_CA_FILE" ] \
    || fail "控制面 CA 文件不可读取"
fi
if [ "$has_existing_environment" = true ]; then
  RAYLINK_ENROLL_TOKEN="$(read_environment_value RAYLINK_ENROLL_TOKEN)" || fail "待接入安装缺少原接入令牌"
fi
printf '%s' "$RAYLINK_ENROLL_TOKEN" | grep -Eq '^[A-Za-z0-9_-]+$' \
  && [ "${#RAYLINK_ENROLL_TOKEN}" -ge 20 ] && [ "${#RAYLINK_ENROLL_TOKEN}" -le 256 ] \
  || fail "接入令牌格式无效"
printf '%s' "$RAYLINK_PROTOCOL_PROBE_URL" | grep -Eq '^https://[^[:space:]]+$' \
  || fail "RAYLINK_PROTOCOL_PROBE_URL 必须是 HTTPS 地址"
[ "$RAYLINK_ENABLE_USER_METERING" = true ] || fail "正式版 RayLink Node 必须启用真实用户计量"
printf '%s' "$SING_BOX_VERSION" | grep -Eq '^1\.[0-9]+\.[0-9]+$' || fail "Runtime 版本格式无效"
printf '%s' "$RAYLINK_NODE_VERSION" | grep -Eq '^[0-9]+$' || fail "Node.js 主版本格式无效"
missing_dependencies=false
for dependency in curl tar xz sha256sum sysctl modprobe ss systemd-tmpfiles; do
  command -v "$dependency" >/dev/null 2>&1 || missing_dependencies=true
done
if [ "$missing_dependencies" = true ]; then
  printf '自动安装下载、校验、网络探测及 BBR 所需系统组件。\n'
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl tar xz-utils coreutils procps kmod iproute2 systemd
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ca-certificates curl tar xz coreutils procps-ng kmod iproute systemd
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ca-certificates curl tar xz coreutils procps-ng kmod iproute systemd
  else
    fail "系统缺少安装依赖，且没有受支持的软件包管理器"
  fi
fi
for dependency in curl tar xz sha256sum sysctl ss systemd-tmpfiles; do
  command -v "$dependency" >/dev/null 2>&1 || fail "系统组件安装后仍缺少 $dependency"
done
if systemctl list-unit-files sing-box.service >/dev/null 2>&1 \
  && { systemctl is-active --quiet sing-box.service || systemctl is-enabled --quiet sing-box.service; }; then
  fail "检测到现有 sing-box.service 正在运行或已启用；请先迁移并停止、禁用现有服务后重试"
fi

machine_arch="$(uname -m)"
case "$machine_arch" in
  x86_64|amd64) node_arch="x64"; runtime_arch="amd64" ;;
  aarch64|arm64) node_arch="arm64"; runtime_arch="arm64" ;;
  *) fail "暂不支持 CPU 架构：$machine_arch" ;;
esac

temporary_root="$(mktemp -d)"
trap 'rm -rf "$temporary_root"' EXIT
download() {
  local allowed_protocols='=https'
  local ca_arguments=(--tlsv1.2)
  case "$1" in
    "$RAYLINK_SERVER"/node/*)
      if [ -n "$RAYLINK_CONTROL_CA_FILE" ]; then ca_arguments+=(--cacert "$RAYLINK_CONTROL_CA_FILE"); fi
      ;;
  esac
  if [ "${RAYLINK_ALLOW_INSECURE_HTTP:-false}" = true ] \
    && printf '%s' "$1" | grep -Eq '^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?/'; then
    allowed_protocols='=http,https'
  fi
  curl -fsSL "$1" --proto "$allowed_protocols" --proto-redir '=https' --connect-timeout 10 --max-time 180 \
    --retry 2 --retry-delay 1 --retry-max-time 360 "${ca_arguments[@]}" -o "$2"
}
# Finish downloads and validation before changing an installed program or unit.
download "$RAYLINK_SERVER/node/raylink-ufw.tmpfiles.conf" "$temporary_root/raylink-node-ufw.conf"
download "$RAYLINK_SERVER/node/raylink-node.mjs" "$temporary_root/raylink-node.mjs"
download "$RAYLINK_SERVER/node/network-tuning.mjs" "$temporary_root/network-tuning.mjs"
download "$RAYLINK_SERVER/node/software-update.mjs" "$temporary_root/software-update.mjs"
node_binary="$RAYLINK_NODE_ROOT/node/bin/node"
staged_node=false
if [ ! -x "$node_binary" ]; then
  node_dist_url="https://nodejs.org/dist/latest-v${RAYLINK_NODE_VERSION}.x"
  download "$node_dist_url/SHASUMS256.txt" "$temporary_root/SHASUMS256.txt"
  node_archive="$(awk -v arch="$node_arch" '$2 ~ ("^node-v[0-9.]+-linux-" arch "\\.tar\\.xz$") { print $2; exit }' "$temporary_root/SHASUMS256.txt")"
  [ -n "$node_archive" ] || fail "无法解析 Node.js v${RAYLINK_NODE_VERSION} 安装包"
  download "$node_dist_url/$node_archive" "$temporary_root/$node_archive"
  (
    cd "$temporary_root"
    grep "  $node_archive\$" SHASUMS256.txt | sha256sum -c -
  )
  mkdir "$temporary_root/node"
  tar -xJf "$temporary_root/$node_archive" -C "$temporary_root/node" --strip-components=1
  node_binary="$temporary_root/node/bin/node"
  staged_node=true
fi
"$node_binary" --check "$temporary_root/raylink-node.mjs" || fail "下载的 Node 程序语法校验失败"
"$node_binary" --check "$temporary_root/network-tuning.mjs" || fail "下载的 BBR 模块语法校验失败"
"$node_binary" --check "$temporary_root/software-update.mjs" || fail "下载的更新模块语法校验失败"
# argv[1] must stay absent during import-only validation; supplying the module
# there would start its CLI polling loop before installation or service handoff.
RAYLINK_VERIFY_MODULE="$temporary_root/raylink-node.mjs" "$node_binary" --input-type=module \
  -e 'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.env.RAYLINK_VERIFY_MODULE).href);' \
  || fail "下载的 Node 程序依赖校验失败"

runtime_name="raylink-sing-box-${SING_BOX_VERSION}-linux-${runtime_arch}"
runtime_url="$RAYLINK_SERVER/node/runtime/$runtime_name"
runtime_candidate="$temporary_root/$runtime_name"
runtime_checksum="$temporary_root/${runtime_name}.sha256"
cronet_name="raylink-libcronet-${SING_BOX_VERSION}-linux-${runtime_arch}.so"
cronet_url="$RAYLINK_SERVER/node/runtime/$cronet_name"
cronet_candidate="$temporary_root/$cronet_name"
cronet_checksum="$temporary_root/${cronet_name}.sha256"
staged_builder=false
if download "$runtime_url" "$runtime_candidate" \
  && download "${runtime_url}.sha256" "$runtime_checksum" \
  && download "$cronet_url" "$cronet_candidate" \
  && download "${cronet_url}.sha256" "$cronet_checksum"; then
  expected_runtime_sha256="$(awk 'NR == 1 { print $1 }' "$runtime_checksum")"
  printf '%s' "$expected_runtime_sha256" | grep -Eq '^[a-f0-9]{64}$' \
    || fail "预编译 Runtime 校验文件格式错误"
  printf '%s  %s\n' "$expected_runtime_sha256" "$runtime_candidate" | sha256sum -c -
  expected_cronet_sha256="$(awk 'NR == 1 { print $1 }' "$cronet_checksum")"
  printf '%s' "$expected_cronet_sha256" | grep -Eq '^[a-f0-9]{64}$' \
    || fail "预编译 Cronet 校验文件格式错误"
  printf '%s  %s\n' "$expected_cronet_sha256" "$cronet_candidate" | sha256sum -c -
  chmod 0755 "$runtime_candidate"
else
  printf '控制台未提供完整 linux-%s 预编译 Runtime，回退到本机编译\n' "$runtime_arch"
  download "$RAYLINK_SERVER/node/build-metered-runtime.sh" "$temporary_root/build-metered-runtime.sh"
  bash -n "$temporary_root/build-metered-runtime.sh" || fail "Runtime 构建脚本语法校验失败"
  chmod 0755 "$temporary_root/build-metered-runtime.sh"
  RAYLINK_NODE_ROOT="$temporary_root/toolchains" "$temporary_root/build-metered-runtime.sh" \
    "$SING_BOX_VERSION" "$temporary_root/raylink-sing-box"
  runtime_candidate="$temporary_root/raylink-sing-box"
  cronet_candidate="$temporary_root/libcronet.so"
  staged_builder=true
fi
runtime_details="$("$runtime_candidate" version)" || fail "候选 Runtime 无法执行"
printf '%s\n' "$runtime_details" | grep -Fxq "sing-box version ${SING_BOX_VERSION}" \
  || fail "候选 Runtime 版本不匹配"
[ -s "$cronet_candidate" ] || fail "候选 Runtime 缺少 Cronet 依赖"
runtime_tags="$(printf '%s\n' "$runtime_details" | sed -n 's/^Tags:[[:space:]]*//p' | tr -d '[:space:]')"
required_runtime_tags="with_gvisor with_quic with_dhcp with_wireguard with_utls with_acme with_clash_api with_tailscale with_ccm with_ocm with_naive_outbound with_v2ray_api with_purego badlinkname tfogo_checklinkname0"
for required_runtime_tag in $required_runtime_tags; do
  printf ',%s,' "$runtime_tags" | grep -Fq ",${required_runtime_tag}," \
    || fail "候选 Runtime 缺少 ${required_runtime_tag}"
done

# Recheck services immediately before committing staged artifacts.
[ ! -e "$node_state" ] || fail "节点已在下载期间接入，请重新执行以确认身份"
if systemctl is-active --quiet raylink-node.service; then
  fail "Node 正在运行，拒绝覆盖其程序或环境"
fi
if systemctl is-active --quiet sing-box.service || systemctl is-enabled --quiet sing-box.service \
  || systemctl is-active --quiet raylink-sing-box.service; then
  fail "检测到正在运行的 Runtime，拒绝覆盖二进制或服务配置"
fi
install -d -m 0755 "$RAYLINK_NODE_ROOT" "$RAYLINK_SYSTEMD_ROOT" "$RAYLINK_TMPFILES_ROOT" "$RAYLINK_SYSCTL_ROOT" "$RAYLINK_RUNTIME_BIN_DIR"
install -d -m 0700 "$RAYLINK_NODE_CONFIG_ROOT"
install -d -m 0750 "$RAYLINK_NODE_DATA_ROOT"
atomic_install() {
  local mode="$1" source="$2" destination="$3"
  local candidate="${destination}.install-$$"
  install -m "$mode" "$source" "$candidate"
  mv -f "$candidate" "$destination"
}
# Persist ownership before the first program replacement, allowing a retry to
# repair an interrupted commit without issuing a second enrollment token.
if [ "$has_existing_environment" = false ]; then
  {
    printf 'RAYLINK_SERVER=%s\n' "$RAYLINK_SERVER"
    printf 'RAYLINK_ENROLL_TOKEN=%s\n' "$RAYLINK_ENROLL_TOKEN"
    printf 'RAYLINK_EXPECT_HOST_ID=%s\n' "$RAYLINK_EXPECT_HOST_ID"
    printf 'RAYLINK_NODE_STATE=%s\n' "$node_state"
    printf 'RAYLINK_NODE_DATA=%s\n' "$RAYLINK_NODE_DATA_ROOT"
    printf 'RAYLINK_RUNTIME_MODE=systemd\n'
    printf 'RAYLINK_BBR_CONFIG=%s/99-raylink-bbr.conf\n' "$RAYLINK_NODE_CONFIG_ROOT"
    printf 'RAYLINK_PROTOCOL_PROBE_URL=%s\n' "$RAYLINK_PROTOCOL_PROBE_URL"
    printf 'RAYLINK_ENABLE_USER_METERING=%s\n' "$RAYLINK_ENABLE_USER_METERING"
    printf 'SING_BOX_BIN=%s\n' "$sing_box_bin"
    printf 'SING_BOX_SYSTEMD_UNIT=raylink-sing-box.service\n'
  } > "$temporary_root/node.env"
elif [ -n "$RAYLINK_CONTROL_CA_FILE" ]; then
  awk '!/^(NODE_EXTRA_CA_CERTS|RAYLINK_CONTROL_CA_FILE)=/' "$node_environment" > "$temporary_root/node.env"
fi
if [ -n "$RAYLINK_CONTROL_CA_FILE" ]; then
  atomic_install 0644 "$RAYLINK_CONTROL_CA_FILE" "$RAYLINK_NODE_CONFIG_ROOT/control-plane-ca.pem"
  {
    printf 'NODE_EXTRA_CA_CERTS=%s/control-plane-ca.pem\n' "$RAYLINK_NODE_CONFIG_ROOT"
    printf 'RAYLINK_CONTROL_CA_FILE=%s/control-plane-ca.pem\n' "$RAYLINK_NODE_CONFIG_ROOT"
  } >> "$temporary_root/node.env"
fi
if [ -f "$temporary_root/node.env" ]; then
  atomic_install 0600 "$temporary_root/node.env" "$node_environment"
fi
if [ "$staged_node" = true ]; then
  node_candidate="$RAYLINK_NODE_ROOT/node.install-$$"
  cp -R "$temporary_root/node" "$node_candidate"
  [ ! -e "$RAYLINK_NODE_ROOT/node" ] || fail "Node.js 安装目录已存在但不可用，请检查后重试"
  mv "$node_candidate" "$RAYLINK_NODE_ROOT/node"
fi
atomic_install 0755 "$temporary_root/raylink-node.mjs" "$RAYLINK_NODE_ROOT/raylink-node.mjs"
atomic_install 0644 "$temporary_root/network-tuning.mjs" "$RAYLINK_NODE_ROOT/network-tuning.mjs"
atomic_install 0644 "$temporary_root/software-update.mjs" "$RAYLINK_NODE_ROOT/software-update.mjs"
# The Node's existing writable configuration directory remains the only place
# it writes; systemd-sysctl follows this link during future boots.
ln -sfn "$RAYLINK_NODE_CONFIG_ROOT/99-raylink-bbr.conf" "$RAYLINK_SYSCTL_ROOT/99-raylink-node-bbr.conf"
if [ "$staged_builder" = true ]; then
  atomic_install 0755 "$temporary_root/build-metered-runtime.sh" "$RAYLINK_NODE_ROOT/build-metered-runtime.sh"
fi
atomic_install 0644 "$cronet_candidate" "$RAYLINK_RUNTIME_BIN_DIR/libcronet.so"
atomic_install 0755 "$runtime_candidate" "$sing_box_bin"
atomic_install 0644 "$temporary_root/raylink-node-ufw.conf" "$RAYLINK_TMPFILES_ROOT/raylink-node-ufw.conf"
systemd-tmpfiles --create "$RAYLINK_TMPFILES_ROOT/raylink-node-ufw.conf"

cat > "$temporary_root/raylink-sing-box.service" <<EOF
[Unit]
Description=RayLink managed sing-box runtime
After=network-online.target systemd-tmpfiles-setup.service
Wants=network-online.target
ConditionPathExists=$RAYLINK_NODE_DATA_ROOT/config.json

[Service]
Type=simple
ExecStart=$sing_box_bin run -c $RAYLINK_NODE_DATA_ROOT/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$RAYLINK_NODE_DATA_ROOT

[Install]
WantedBy=multi-user.target
EOF

cat > "$temporary_root/raylink-node.service" <<EOF
[Unit]
Description=RayLink Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$node_environment
ExecStart=$RAYLINK_NODE_ROOT/node/bin/node $RAYLINK_NODE_ROOT/raylink-node.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$RAYLINK_NODE_CONFIG_ROOT $RAYLINK_NODE_DATA_ROOT $RAYLINK_NODE_ROOT $RAYLINK_RUNTIME_BIN_DIR -/run/ufw.lock -/run/xtables.lock -/etc/ufw/user.rules -/etc/ufw/user6.rules

[Install]
WantedBy=multi-user.target
EOF
atomic_install 0644 "$temporary_root/raylink-sing-box.service" "$RAYLINK_SYSTEMD_ROOT/raylink-sing-box.service"
atomic_install 0644 "$temporary_root/raylink-node.service" "$RAYLINK_SYSTEMD_ROOT/raylink-node.service"
systemctl daemon-reload
systemctl enable raylink-sing-box.service
systemctl enable raylink-node.service
if ! systemctl is-active --quiet raylink-node.service; then systemctl start raylink-node.service; fi

printf '\nRayLink Node 已安装并启动，等待接入确认。\n'
printf '节点状态：systemctl status raylink-node --no-pager\n'
printf '节点日志：journalctl -u raylink-node -f\n'
