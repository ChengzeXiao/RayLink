#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'RayLink 一键安装失败：%s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
RayLink 一键安装

用法：
  install.sh [--public-ip IP] [--version VERSION]
             [--release-base-url URL] [--dry-run]

参数：
  --public-ip IP           控制台对外访问 IP；留空时尝试自动检测
  --version VERSION        安装版本，默认 0.2.46
  --release-base-url URL   发布包根地址，默认使用 RayLink GitHub Releases
  --dry-run                只下载、校验和解压，不修改系统
  -h, --help               显示帮助

同名环境变量：
  RAYLINK_PUBLIC_IP
  RAYLINK_VERSION
  RAYLINK_RELEASE_BASE_URL
EOF
}

version="${RAYLINK_VERSION:-0.2.46}"
public_ip="${RAYLINK_PUBLIC_IP:-}"
default_release_base_url="https://github.com/ChengzeXiao/RayLink/releases/download"
release_base_url="${RAYLINK_RELEASE_BASE_URL:-$default_release_base_url}"
dry_run=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --public-ip)
      [ "$#" -ge 2 ] && [[ "$2" != -* ]] || fail "--public-ip 缺少参数"
      public_ip="$2"
      shift 2
      ;;
    --version)
      [ "$#" -ge 2 ] && [[ "$2" != -* ]] || fail "--version 缺少参数"
      version="$2"
      shift 2
      ;;
    --release-base-url)
      [ "$#" -ge 2 ] && [[ "$2" != -* ]] || fail "--release-base-url 缺少参数"
      release_base_url="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数：$1"
      ;;
  esac
done

printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "版本格式无效：$version"
[ -n "$release_base_url" ] || fail "发布包地址不能为空"

command -v curl >/dev/null 2>&1 || fail "需要 curl；请先安装 curl 后重试"

if [ "$dry_run" = false ]; then
  [ "$(uname -s)" = "Linux" ] || fail "当前一键安装仅支持 Linux"
  [ "$(id -u)" -eq 0 ] || fail "请通过 sudo 以 root 运行"
fi

missing_release_tools=()
command -v tar >/dev/null 2>&1 || missing_release_tools+=("tar")
command -v sha256sum >/dev/null 2>&1 || missing_release_tools+=("sha256sum")
if [ "${#missing_release_tools[@]}" -gt 0 ]; then
  if [ "$dry_run" = true ]; then
    fail "缺少发布包工具：${missing_release_tools[*]}"
  fi
  command -v apt-get >/dev/null 2>&1 \
    || fail "缺少发布包工具：${missing_release_tools[*]}；且系统不支持 apt-get 自动安装"
  printf '正在安装发布包校验工具：%s…\n' "${missing_release_tools[*]}"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates tar coreutils
fi

gnu_tar=false
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  gnu_tar=true
fi

read_archive() {
  if [ "$gnu_tar" = true ]; then
    tar --warning=no-unknown-keyword "$@"
  else
    tar "$@"
  fi
}

case "$(uname -m)" in
  x86_64|amd64) architecture=amd64 ;;
  aarch64|arm64) architecture=arm64 ;;
  *) fail "不支持的 CPU 架构：$(uname -m)" ;;
esac

temporary_root="$(mktemp -d)"
trap 'rm -rf "$temporary_root"' EXIT

archive_name="raylink-${version}-linux-${architecture}.tar.gz"
checksum_name="${archive_name}.sha256"
release_url="${release_base_url%/}/v${version}"
archive_url="${release_url}/${archive_name}"
checksum_url="${release_url}/${checksum_name}"
archive_path="${temporary_root}/${archive_name}"
checksum_path="${temporary_root}/${checksum_name}"

printf '正在准备 RayLink v%s（linux-%s）…\n' "$version" "$architecture"
curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 \
  "$archive_url" \
  -o "$archive_path"
curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 \
  "$checksum_url" \
  -o "$checksum_path"

checksum_lines="$(awk 'NF { count += 1 } END { print count + 0 }' "$checksum_path")"
[ "$checksum_lines" -eq 1 ] || fail "发布包校验文件格式错误"
expected_sha256="$(awk 'NF { print $1 }' "$checksum_path")"
printf '%s' "$expected_sha256" | grep -Eq '^[a-f0-9]{64}$' \
  || fail "发布包校验值格式错误"
printf '%s  %s\n' "$expected_sha256" "$archive_name" \
  | (cd "$temporary_root" && sha256sum -c -) \
  || fail "发布包 SHA-256 校验失败"
printf 'SHA-256 校验通过。\n'

archive_listing="$(read_archive -tzf "$archive_path")" \
  || fail "发布包无法读取"
[ -n "$archive_listing" ] || fail "发布包为空"
if printf '%s\n' "$archive_listing" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  fail "发布包包含不安全路径"
fi
expected_root="raylink-${version}"
while IFS= read -r archive_entry; do
  case "$archive_entry" in
    "._${expected_root}") ;;
    "$expected_root"|"$expected_root"/*) ;;
    *) fail "发布包目录结构不正确" ;;
  esac
done <<EOF
$archive_listing
EOF
if read_archive -tvzf "$archive_path" | grep -Eq '^[lh]'; then
  fail "发布包不能包含符号链接或硬链接"
fi

read_archive \
  --exclude="._${expected_root}" \
  --exclude='*/._*' \
  -xzf "$archive_path" \
  -C "$temporary_root"
installer="${temporary_root}/${expected_root}/deploy/install-control-plane.sh"
upgrade_installer="${temporary_root}/${expected_root}/deploy/upgrade-control-plane.sh"
install_root="${RAYLINK_INSTALL_ROOT:-/opt/raylink}"
pending_install="${RAYLINK_CONFIG_ROOT:-/etc/raylink}/install-pending"
if [ -f "$install_root/package.json" ] \
  && ! { [ -f "${temporary_root}/${expected_root}/deploy/initial-install-state.sh" ] \
    && bash "${temporary_root}/${expected_root}/deploy/initial-install-state.sh" pending "$pending_install" \
      "${RAYLINK_DATA_ROOT:-/var/lib/raylink}" "${RAYLINK_NODE_ROOT:-/opt/raylink-nodejs}"; }; then
  action=upgrade
  installer="$upgrade_installer"
  [ -f "$installer" ] || fail "发布包缺少控制面升级器"
else
  action=install
  [ -f "$installer" ] || fail "发布包缺少控制面安装器"
fi

if [ -z "$public_ip" ] && [ "$dry_run" = false ]; then
  public_ip="$(
    curl -fsSL --connect-timeout 5 https://api64.ipify.org 2>/dev/null || true
  )"
  if [ -n "$public_ip" ]; then
    printf '自动检测到公网 IP：%s\n' "$public_ip"
  fi
fi

if [ "$dry_run" = true ]; then
  printf 'Dry run 完成，未修改系统。将执行：\n'
  if [ "$action" = upgrade ]; then
    if [ -n "$public_ip" ]; then
      printf 'RAYLINK_INSTALL_ROOT=%q RAYLINK_PUBLIC_IP=%q bash %q\n' \
        "$install_root" "$public_ip" "$installer"
    else
      printf 'RAYLINK_INSTALL_ROOT=%q bash %q\n' "$install_root" "$installer"
    fi
  elif [ -n "$public_ip" ]; then
    printf 'RAYLINK_PUBLIC_IP=%q bash %q\n' "$public_ip" "$installer"
  else
    printf 'bash %q\n' "$installer"
  fi
  exit 0
fi

if [ "$action" = upgrade ]; then
  printf '发布包准备完成，开始安全升级控制面（sing-box Runtime 保持运行）…\n'
  RAYLINK_INSTALL_ROOT="$install_root" \
    RAYLINK_PUBLIC_IP="$public_ip" \
    bash "$installer"
elif [ -n "$public_ip" ]; then
  printf '发布包准备完成，开始安装控制面与 Runtime…\n'
  RAYLINK_PUBLIC_IP="$public_ip" bash "$installer"
else
  printf '发布包准备完成，开始安装控制面与 Runtime…\n'
  bash "$installer"
fi
