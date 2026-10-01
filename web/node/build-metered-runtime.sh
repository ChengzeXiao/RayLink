#!/usr/bin/env bash
set -euo pipefail

SING_BOX_VERSION="${1:-}"
OUTPUT_PATH="${2:-/usr/local/bin/raylink-sing-box}"
script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ "$script_directory" = "/opt/raylink-node" ]; then
  default_build_root=/opt/raylink-node
else
  default_build_root=/var/lib/raylink/toolchains
fi
RAYLINK_NODE_ROOT="${RAYLINK_NODE_ROOT:-$default_build_root}"
GO_VERSION="${GO_VERSION:-1.26.8}"
SING_BOX_BUILD_TAGS="${SING_BOX_BUILD_TAGS:-with_gvisor,with_quic,with_dhcp,with_wireguard,with_utls,with_acme,with_clash_api,with_tailscale,with_ccm,with_ocm,with_naive_outbound,with_v2ray_api,with_purego,badlinkname,tfogo_checklinkname0}"
SING_BOX_LDFLAGS="${SING_BOX_LDFLAGS:--X github.com/sagernet/sing-box/constant.Version=${SING_BOX_VERSION} -X internal/godebug.defaultGODEBUG=multipathtcp=0 -s -w -buildid= -checklinkname=0}"

fail() {
  printf 'RayLink 计量版 Runtime 构建失败：%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "必须以 root 运行"
printf '%s' "$SING_BOX_VERSION" | grep -Eq '^1\.14\.2$' || fail "只允许构建 sing-box 1.14.2"
case "$SING_BOX_VERSION" in
  1.14.2) expected_module_sum='h1:uZX7iz70o7lzoltR6sElMYP7kI7PVf23r4X0HQSozXM=' ;;
  *) fail "该版本尚未进入 RayLink 审批清单，缺少源码模块校验值" ;;
esac
printf '%s' "$OUTPUT_PATH" | grep -Eq '^/[A-Za-z0-9_./-]+$' || fail "输出路径无效"
command -v curl >/dev/null 2>&1 || fail "需要 curl"
command -v tar >/dev/null 2>&1 || fail "需要 tar"
command -v sha256sum >/dev/null 2>&1 || fail "需要 sha256sum"

case "$(uname -m)" in
  x86_64|amd64) go_arch="amd64" ;;
  aarch64|arm64) go_arch="arm64" ;;
  *) fail "不支持的 CPU 架构：$(uname -m)" ;;
esac
target_arch="${RAYLINK_TARGET_ARCH:-$go_arch}"
case "$target_arch" in
  amd64|arm64) ;;
  *) fail "不支持的目标 CPU 架构：$target_arch" ;;
esac
case "${GO_VERSION}:${go_arch}" in
  1.26.8:amd64) expected_go_sha256="d0f743b33e8d8945e6b1f432edd15785c70507121d6e2a723b21285eddf8b57b" ;;
  1.26.8:arm64) expected_go_sha256="211ffced9dcb9633a55eac6364816ec0ddd951389a740e88fa8b3337971bdda0" ;;
  *) fail "该 Go 版本或架构尚未进入 RayLink 审批清单" ;;
esac
case "${SING_BOX_VERSION}:${target_arch}" in
  1.14.2:amd64) expected_official_archive_sha256="a684484d7477d1437282ee411f4d131d0340aaad60a7868841ebd5d87dd8a0c6" ;;
  1.14.2:arm64) expected_official_archive_sha256="b43a1fb1bda131c6653576741ce527eb2bdeab7c9308ca90ee8b972abb7e4a7f" ;;
  *) fail "该 sing-box 版本或架构缺少已审批的 Cronet 依赖校验值" ;;
esac

go_root="$RAYLINK_NODE_ROOT/go"
go_binary="$go_root/bin/go"
if [ ! -x "$go_binary" ] || ! "$go_binary" version | grep -q "go${GO_VERSION}"; then
  archive="go${GO_VERSION}.linux-${go_arch}.tar.gz"
  download_dir="$(mktemp -d)"
  trap 'rm -rf "$download_dir"' EXIT
  curl -fsSL "https://go.dev/dl/${archive}" -o "$download_dir/$archive"
  printf '%s  %s\n' "$expected_go_sha256" "$download_dir/$archive" | sha256sum -c -
  rm -rf "$go_root"
  install -d -m 0755 "$go_root"
  tar -xzf "$download_dir/$archive" -C "$go_root" --strip-components=1
fi

build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir" "${download_dir:-}"' EXIT
install -d -m 0700 "$RAYLINK_NODE_ROOT/gopath" "$RAYLINK_NODE_ROOT/gocache"
module_metadata="$(
  GOPATH="$RAYLINK_NODE_ROOT/gopath" \
  GOCACHE="$RAYLINK_NODE_ROOT/gocache" \
  GOSUMDB=sum.golang.org \
  "$go_binary" mod download -json "github.com/sagernet/sing-box@v${SING_BOX_VERSION}"
)"
actual_module_sum="$(printf '%s\n' "$module_metadata" | sed -n 's/^[[:space:]]*"Sum": "\([^"]*\)",[[:space:]]*$/\1/p')"
[ "$actual_module_sum" = "$expected_module_sum" ] \
  || fail "sing-box 源码模块校验失败"
module_directory="$(printf '%s\n' "$module_metadata" | sed -n 's/^[[:space:]]*"Dir": "\([^"]*\)",[[:space:]]*$/\1/p')"
[ -d "$module_directory/cmd/sing-box" ] \
  || fail "无法定位已校验的 sing-box 源码目录"
(
cd "$module_directory"
GOPATH="$RAYLINK_NODE_ROOT/gopath" \
GOCACHE="$RAYLINK_NODE_ROOT/gocache" \
GOSUMDB=sum.golang.org \
GOOS=linux \
GOARCH="$target_arch" \
CGO_ENABLED=0 "$go_binary" build \
  -o "$build_dir/sing-box" \
  -trimpath \
  -tags "$SING_BOX_BUILD_TAGS" \
  -ldflags "$SING_BOX_LDFLAGS" \
  ./cmd/sing-box
)

official_archive="sing-box-${SING_BOX_VERSION}-linux-${target_arch}.tar.gz"
curl -fsSL \
  "https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX_VERSION}/${official_archive}" \
  -o "$build_dir/$official_archive"
printf '%s  %s\n' \
  "$expected_official_archive_sha256" \
  "$build_dir/$official_archive" \
  | sha256sum -c -
tar -xzf "$build_dir/$official_archive" \
  -C "$build_dir" \
  --strip-components=1 \
  "sing-box-${SING_BOX_VERSION}-linux-${target_arch}/libcronet.so"
[ -s "$build_dir/libcronet.so" ] \
  || fail "官方发布包缺少 Naive 外部探针所需的 libcronet.so"

candidate="${OUTPUT_PATH}.candidate"
library_output="$(dirname -- "$OUTPUT_PATH")/libcronet.so"
library_candidate="${library_output}.candidate"
install -m 0755 "$build_dir/sing-box" "$candidate"
install -m 0644 "$build_dir/libcronet.so" "$library_candidate"
if [ "$target_arch" = "$go_arch" ]; then
  runtime_details="$("$candidate" version)" || fail "构建结果无法执行"
  printf '%s\n' "$runtime_details" | grep -q "sing-box version ${SING_BOX_VERSION}" \
    || fail "构建版本校验失败"
  runtime_tags="$(printf '%s\n' "$runtime_details" | sed -n 's/^Tags:[[:space:]]*//p' | tr -d '[:space:]')"
  for required_runtime_tag in $(printf '%s' "$SING_BOX_BUILD_TAGS" | tr ',' ' '); do
    printf ',%s,' "$runtime_tags" | grep -Fq ",${required_runtime_tag}," \
      || fail "构建结果缺少 ${required_runtime_tag}"
  done
else
  [ "${RAYLINK_ALLOW_CROSS_BUILD:-false}" = "true" ] \
    || fail "交叉构建必须显式设置 RAYLINK_ALLOW_CROSS_BUILD=true，并在目标用户空间执行最终校验"
  command -v file >/dev/null 2>&1 || fail "交叉构建需要 file"
  candidate_format="$(file -b "$candidate")"
  case "$target_arch" in
    amd64) printf '%s' "$candidate_format" | grep -q "x86-64" \
      || fail "交叉构建结果不是 AMD64 ELF" ;;
    arm64) printf '%s' "$candidate_format" | grep -Eq "aarch64|ARM aarch64" \
      || fail "交叉构建结果不是 ARM64 ELF" ;;
  esac
  printf '交叉构建已验证 ELF 架构；发布前必须在 linux-%s 用户空间运行 version 校验\n' \
    "$target_arch"
fi
mv -f "$library_candidate" "$library_output"
mv -f "$candidate" "$OUTPUT_PATH"
printf 'RayLink 计量版 sing-box %s 已安装到 %s\n' "$SING_BOX_VERSION" "$OUTPUT_PATH"
printf 'RayLink Naive 探针依赖已安装到 %s\n' "$library_output"
