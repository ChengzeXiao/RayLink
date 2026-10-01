#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'RayLink 安装失败：%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "请以 root 运行"
[ "$(uname -s)" = "Linux" ] || fail "当前一键安装仅支持 Linux"
command -v systemctl >/dev/null 2>&1 || fail "当前系统未使用 systemd"
if command -v caddy >/dev/null 2>&1 || [ -e /etc/caddy/Caddyfile ]; then
  fail "检测到已有 Caddy；为避免覆盖现有站点，请使用全新 VPS 或先迁移现有 Caddy 配置"
fi

install_root=/opt/raylink
data_root=/var/lib/raylink
config_root=/etc/raylink
managed_root="$data_root/managed"
node_root=/opt/raylink-nodejs
node_version="${RAYLINK_NODE_VERSION:-22.23.1}"
package_url="${RAYLINK_PACKAGE_URL:-}"
package_sha256="${RAYLINK_PACKAGE_SHA256:-}"
source_root="${RAYLINK_SOURCE_DIR:-}"
temporary_root="$(mktemp -d)"
installation_succeeded=false
caddyfile_backup=
cleanup() {
  status=$?
  trap - EXIT
  if [ "$installation_succeeded" != true ] \
    && [ -n "$caddyfile_backup" ] \
    && [ -f "$caddyfile_backup" ]; then
    unlink /etc/caddy/Caddyfile 2>/dev/null || true
    cp -a "$caddyfile_backup" /etc/caddy/Caddyfile
    if systemctl is-active --quiet caddy; then
      caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$temporary_root"
  exit "$status"
}
trap cleanup EXIT

if [ -e "$install_root/package.json" ]; then
  fail "$install_root 已存在；升级请使用控制台在线升级，不要覆盖安装"
fi

public_ip="${RAYLINK_PUBLIC_IP:-}"
public_ip_was_detected=false
if [ -z "$public_ip" ]; then
  public_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  public_ip_was_detected=true
fi
[ -n "$public_ip" ] || fail "无法检测服务器 IP，请设置 RAYLINK_PUBLIC_IP"
printf '%s' "$public_ip" | grep -Eq '^[0-9a-fA-F:.]+$' || fail "RAYLINK_PUBLIC_IP 格式不正确"
if [ "$public_ip_was_detected" = true ]; then
  normalized_ip="$(printf '%s' "$public_ip" | tr '[:upper:]' '[:lower:]')"
  case "$normalized_ip" in
    0.*|10.*|127.*|169.254.*|192.168.*|\
    172.1[6-9].*|172.2[0-9].*|172.3[01].*|\
    100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*|\
    ::1|fe8*|fe9*|fea*|feb*|fc*|fd*)
      fail "自动检测到私网地址 $public_ip；请显式设置 RAYLINK_PUBLIC_IP=公网IP（局域网部署也需显式设置）"
      ;;
  esac
fi
case "$public_ip" in
  *:*) public_host="[$public_ip]" ;;
  *) public_host="$public_ip" ;;
esac
public_origin="https://${public_host}"

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y \
    apt-transport-https \
    ca-certificates \
    curl \
    debian-archive-keyring \
    debian-keyring \
    gnupg \
    iproute2 \
    kmod \
    openssl \
    tar \
    xz-utils
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    -o "$temporary_root/caddy-stable.gpg.key"
  caddy_key_fingerprint="$(
    gpg --batch --show-keys --with-colons "$temporary_root/caddy-stable.gpg.key" \
      | awk -F: '$1 == "fpr" { print $10; exit }'
  )"
  [ "$caddy_key_fingerprint" = "65760C51EDEA2017CEA2CA15155B6D79CA56EA34" ] \
    || fail "Caddy 仓库签名密钥指纹不匹配"
  gpg --dearmor --yes \
    -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    "$temporary_root/caddy-stable.gpg.key"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    -o /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r \
    /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
else
  fail "当前版本仅自动安装 Debian/Ubuntu 依赖"
fi

case "$(uname -m)" in
  x86_64|amd64) node_arch=x64; runtime_arch=amd64 ;;
  aarch64|arm64) node_arch=arm64; runtime_arch=arm64 ;;
  *) fail "不支持的 CPU 架构：$(uname -m)" ;;
esac

node_archive="node-v${node_version}-linux-${node_arch}.tar.xz"
curl -fsSL "https://nodejs.org/download/release/v${node_version}/SHASUMS256.txt" \
  -o "$temporary_root/SHASUMS256.txt"
curl -fsSL "https://nodejs.org/download/release/v${node_version}/${node_archive}" \
  -o "$temporary_root/$node_archive"
grep "  ${node_archive}\$" "$temporary_root/SHASUMS256.txt" \
  | (cd "$temporary_root" && sha256sum -c -)
install -d -m 0755 "$node_root"
tar -xJf "$temporary_root/$node_archive" -C "$node_root" --strip-components=1
"$node_root/bin/node" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) process.exit(1);
' || fail "Node.js 版本必须不低于 22.5"

if [ -z "$source_root" ]; then
  script_directory="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
  if [ -n "$script_directory" ] && [ -f "$script_directory/../package.json" ]; then
    source_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
  elif [ -n "$package_url" ]; then
    [ -n "$package_sha256" ] || fail "远程安装必须设置 RAYLINK_PACKAGE_SHA256"
    curl -fsSL "$package_url" -o "$temporary_root/raylink.tar.gz"
    printf '%s  %s\n' "$package_sha256" "$temporary_root/raylink.tar.gz" | sha256sum -c -
    install -d -m 0755 "$temporary_root/package"
    tar -xzf "$temporary_root/raylink.tar.gz" -C "$temporary_root/package" --strip-components=1
    source_root="$temporary_root/package"
  else
    fail "请从发布包运行脚本，或设置 RAYLINK_PACKAGE_URL 与 RAYLINK_PACKAGE_SHA256"
  fi
fi

[ -f "$source_root/package.json" ] || fail "安装源缺少 package.json"
[ -f "$source_root/server/index.js" ] || fail "安装源缺少控制面程序"
[ -f "$source_root/web/node/build-metered-runtime.sh" ] || fail "安装源缺少 sing-box 构建器"

install -d -m 0755 "$install_root"
cp -a "$source_root/package.json" "$source_root/server" "$source_root/web" "$source_root/deploy" "$install_root/"
install -d -m 0710 -o root -g caddy "$data_root"
install -d -m 0750 -o root -g caddy "$managed_root"
install -d -m 0700 "$config_root"
install -d -m 0750 -o root -g caddy /etc/caddy/raylink

runtime_version=1.14.2
runtime_artifact="$source_root/web/node/runtime/raylink-sing-box-${runtime_version}-linux-${runtime_arch}"
runtime_checksum="${runtime_artifact}.sha256"
cronet_artifact="$source_root/web/node/runtime/raylink-libcronet-${runtime_version}-linux-${runtime_arch}.so"
cronet_checksum="${cronet_artifact}.sha256"
if [ -f "$runtime_artifact" ] && [ -f "$runtime_checksum" ] \
  && [ -f "$cronet_artifact" ] && [ -f "$cronet_checksum" ]; then
  expected_runtime_sha256="$(awk 'NR == 1 { print $1 }' "$runtime_checksum")"
  printf '%s' "$expected_runtime_sha256" | grep -Eq '^[a-f0-9]{64}$' \
    || fail "预编译 Runtime 校验文件格式错误"
  printf '%s  %s\n' "$expected_runtime_sha256" "$runtime_artifact" | sha256sum -c -
  expected_cronet_sha256="$(awk 'NR == 1 { print $1 }' "$cronet_checksum")"
  printf '%s' "$expected_cronet_sha256" | grep -Eq '^[a-f0-9]{64}$' \
    || fail "预编译 Cronet 校验文件格式错误"
  printf '%s  %s\n' "$expected_cronet_sha256" "$cronet_artifact" | sha256sum -c -
  runtime_candidate="$temporary_root/raylink-sing-box"
  install -m 0755 "$runtime_artifact" "$runtime_candidate"
  runtime_details="$("$runtime_candidate" version)" \
    || fail "预编译 Runtime 无法执行"
  printf '%s\n' "$runtime_details" | grep -q "sing-box version ${runtime_version}" \
    || fail "预编译 Runtime 版本不匹配"
  runtime_tags="$(printf '%s\n' "$runtime_details" | sed -n 's/^Tags:[[:space:]]*//p' | tr -d '[:space:]')"
  required_runtime_tags="with_gvisor with_quic with_dhcp with_wireguard with_utls with_acme with_clash_api with_tailscale with_ccm with_ocm with_naive_outbound with_v2ray_api with_purego badlinkname tfogo_checklinkname0"
  for required_runtime_tag in $required_runtime_tags; do
    printf ',%s,' "$runtime_tags" | grep -Fq ",${required_runtime_tag}," \
      || fail "预编译 Runtime 缺少 ${required_runtime_tag}"
  done
  install -m 0644 "$cronet_artifact" /usr/local/bin/libcronet.so
  install -m 0755 "$runtime_candidate" /usr/local/bin/raylink-sing-box
  printf '已安装预编译 RayLink Runtime（linux-%s）\n' "$runtime_arch"
else
  printf '未找到完整预编译 Runtime 或 Cronet 依赖，回退到本机编译\n'
  "$install_root/web/node/build-metered-runtime.sh" \
    "$runtime_version" \
    /usr/local/bin/raylink-sing-box
fi

openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 825 \
  -subj "/CN=${public_ip}" \
  -addext "subjectAltName=IP:${public_ip}" \
  -keyout /etc/caddy/raylink/control-plane.key \
  -out /etc/caddy/raylink/control-plane.crt
chown root:caddy \
  /etc/caddy/raylink/control-plane.key \
  /etc/caddy/raylink/control-plane.crt
chmod 0640 /etc/caddy/raylink/control-plane.key
chmod 0644 /etc/caddy/raylink/control-plane.crt

setup_token="$(openssl rand -hex 24)"
setup_token_hash="$(
  printf '%s' "$setup_token" | "$node_root/bin/node" -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    process.stdout.write(createHash("sha256").update(readFileSync(0)).digest("base64url"));
  '
)"
setup_expires_at="$(
  "$node_root/bin/node" -e '
    process.stdout.write(new Date(Date.now() + 30 * 60 * 1000).toISOString());
  '
)"
bootstrap_password="$(openssl rand -base64 36 | tr -d '\n')"
subscription_encryption_key="$(openssl rand -base64 36 | tr -d '\n')"

umask 077
{
  printf '%s\n' \
    'NODE_ENV=production' \
    'RAYLINK_HOST=127.0.0.1' \
    'RAYLINK_PORT=4173' \
    "RAYLINK_PUBLIC_ORIGIN=${public_origin}" \
    "RAYLINK_SUBSCRIPTION_ORIGIN=${public_origin}" \
    'RAYLINK_TRUST_PROXY=true' \
    'RAYLINK_ADMIN_USERNAME=bootstrap-admin' \
    "RAYLINK_ADMIN_PASSWORD=${bootstrap_password}" \
    "RAYLINK_SUBSCRIPTION_ENCRYPTION_KEY=${subscription_encryption_key}" \
    "RAYLINK_DATA_DIR=${data_root}" \
    "RAYLINK_PROXY_HOST=${public_ip}" \
    "RAYLINK_LOCAL_HOST_DIAL_ADDRESS=${public_ip}" \
    'RAYLINK_ENDPOINT_DNS_SERVERS=1.1.1.1,8.8.8.8' \
    'RAYLINK_ENDPOINT_DNS_TIMEOUT_MS=2000' \
    'RAYLINK_ENDPOINT_PROBE_TIMEOUT_MS=1500' \
    'RAYLINK_PROXY_PORT=8388' \
    'RAYLINK_RUNTIME_MODE=systemd' \
    'RAYLINK_USER_METERING=true' \
    'RAYLINK_SETUP_REQUIRED=true' \
    "RAYLINK_SETUP_TOKEN_HASH=${setup_token_hash}" \
    "RAYLINK_SETUP_TOKEN_EXPIRES_AT=${setup_expires_at}" \
    'RAYLINK_CADDY_BIN=/usr/bin/caddy' \
    "RAYLINK_CADDYFILE=${managed_root}/Caddyfile" \
    "RAYLINK_ENV_FILE=${managed_root}/raylink.env" \
    "RAYLINK_BBR_CONFIG=${managed_root}/99-raylink-bbr.conf" \
    'RAYLINK_CONTROL_CERT=/etc/caddy/raylink/control-plane.crt' \
    'RAYLINK_CONTROL_KEY=/etc/caddy/raylink/control-plane.key' \
    'SING_BOX_BIN=/usr/local/bin/raylink-sing-box' \
    'SING_BOX_SYSTEMD_UNIT=sing-box-raylink.service'
} > "$managed_root/raylink.env"
chmod 0600 "$managed_root/raylink.env"
ln -sfn "$managed_root/raylink.env" "$config_root/raylink.env"
install -m 0644 /dev/null "$managed_root/99-raylink-bbr.conf"
ln -sfn "$managed_root/99-raylink-bbr.conf" /etc/sysctl.d/99-raylink-bbr.conf

cp "$install_root/deploy/raylink.service" /etc/systemd/system/raylink.service
cp "$install_root/deploy/sing-box-raylink.service" /etc/systemd/system/sing-box-raylink.service
install -m 0644 \
  "$install_root/web/node/raylink-ufw.tmpfiles.conf" \
  /usr/lib/tmpfiles.d/raylink-ufw.conf
systemd-tmpfiles --create /usr/lib/tmpfiles.d/raylink-ufw.conf
caddyfile_backup="$temporary_root/Caddyfile.before-raylink"
cp -a /etc/caddy/Caddyfile "$caddyfile_backup"
sed "s|__RAYLINK_PUBLIC_HOST__|${public_host}|g" \
  "$install_root/deploy/caddy-first-run.Caddyfile" \
  > "$managed_root/Caddyfile"
chown root:caddy "$managed_root/Caddyfile"
chmod 0640 "$managed_root/Caddyfile"
ln -sfn "$managed_root/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config "$managed_root/Caddyfile" --adapter caddyfile
systemctl daemon-reload
if command -v ufw >/dev/null 2>&1 \
  && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow 80/tcp comment 'RayLink Caddy HTTP'
  ufw allow 443/tcp comment 'RayLink Caddy HTTPS'
fi
systemctl enable --now caddy
systemctl reload caddy
systemctl enable sing-box-raylink
systemctl enable --now raylink
installation_succeeded=true

printf '\nRayLink 已安装。\n'
printf '首次初始化地址（令牌 30 分钟有效）：\n'
printf '%s/setup#token=%s\n\n' "$public_origin" "$setup_token"
printf '首次使用 IP 证书时浏览器会提示自签名证书；核对证书指纹后继续：\n'
openssl x509 \
  -in /etc/caddy/raylink/control-plane.crt \
  -noout \
  -fingerprint \
  -sha256
