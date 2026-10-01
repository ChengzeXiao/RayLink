#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'RayLink Runtime 产物构建失败：%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "请以 root 运行"
runtime_version="${1:-1.14.2}"
script_directory="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
output_root="${2:-$script_directory/../web/node/runtime}"
requested_arch="${3:-}"

if [ -n "$requested_arch" ]; then
  runtime_arch="$requested_arch"
else
  case "$(uname -m)" in
    x86_64|amd64) runtime_arch=amd64 ;;
    aarch64|arm64) runtime_arch=arm64 ;;
    *) fail "不支持的 CPU 架构：$(uname -m)" ;;
  esac
fi
case "$runtime_arch" in
  amd64|arm64) ;;
  *) fail "不支持的目标 CPU 架构：$runtime_arch" ;;
esac

install -d -m 0755 "$output_root"
output_root="$(CDPATH= cd -- "$output_root" && pwd)"
artifact="$output_root/raylink-sing-box-${runtime_version}-linux-${runtime_arch}"
cronet_artifact="$output_root/raylink-libcronet-${runtime_version}-linux-${runtime_arch}.so"
case "$(uname -m)" in
  x86_64|amd64) builder_arch=amd64 ;;
  aarch64|arm64) builder_arch=arm64 ;;
  *) fail "不支持的构建机 CPU 架构：$(uname -m)" ;;
esac
if [ "$runtime_arch" != "$builder_arch" ]; then
  allow_cross_build=true
else
  allow_cross_build=false
fi
RAYLINK_ALLOW_CROSS_BUILD="$allow_cross_build" \
RAYLINK_TARGET_ARCH="$runtime_arch" \
  "$script_directory/../web/node/build-metered-runtime.sh" "$runtime_version" "$artifact"
[ -s "$output_root/libcronet.so" ] \
  || fail "Runtime 构建未生成 Naive 探针依赖 libcronet.so"
install -m 0644 "$output_root/libcronet.so" "$cronet_artifact"
(
  cd "$output_root"
  sha256sum "$(basename "$artifact")" > "$(basename "$artifact").sha256"
  sha256sum "$(basename "$cronet_artifact")" > "$(basename "$cronet_artifact").sha256"
)
printf 'RayLink Runtime 发布产物：%s\n' "$artifact"
printf 'RayLink Runtime Cronet 依赖：%s\n' "$cronet_artifact"
