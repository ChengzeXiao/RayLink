#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'RayLink 发布包构建失败：%s\n' "$1" >&2
  exit 1
}

script_directory="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
release_version="${1:-0.2.43}"
release_arches="${RAYLINK_RELEASE_ARCHES:-amd64}"
runtime_version="${RAYLINK_RUNTIME_VERSION:-1.14.2}"
release_arch_count="$(printf '%s\n' "$release_arches" | awk '{ print NF }')"
[ "$release_arch_count" -eq 1 ] \
  || fail "每个正式发布包必须只包含一个目标架构"
if [ -n "${2:-}" ]; then
  output_path="$2"
else
  output_path="$source_root/output/raylink-${release_version}-linux-${release_arches}.tar.gz"
fi

printf '%s' "$release_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "发布版本格式无效"
command -v sha256sum >/dev/null 2>&1 || fail "需要 sha256sum"
command -v tar >/dev/null 2>&1 || fail "需要 tar"
command -v git >/dev/null 2>&1 || fail "需要 git"
command -v node >/dev/null 2>&1 || fail "需要 Node.js 22.5+"
package_version="$(
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version;
    process.stdout.write(String(value || ""));
  ' "$source_root/package.json"
)"
[ "$package_version" = "$release_version" ] \
  || fail "发布版本 v${release_version} 与 package.json v${package_version} 不一致"

git_root="$(git -C "$source_root" rev-parse --show-toplevel 2>/dev/null)" \
  || fail "发布包必须从 Git 工作区构建"
source_prefix="$(git -C "$source_root" rev-parse --show-prefix)"
source_prefix="${source_prefix%/}"
git -C "$source_root" diff --quiet -- . \
  || fail "应用源码存在未提交修改，请提交后再构建发布包"
git -C "$source_root" diff --cached --quiet -- . \
  || fail "应用源码存在已暂存但未提交的修改，请提交后再构建发布包"

output_directory="$(dirname -- "$output_path")"
install -d -m 0755 "$output_directory"
output_directory="$(CDPATH= cd -- "$output_directory" && pwd)"
output_path="$output_directory/$(basename -- "$output_path")"
expected_output_name="raylink-${release_version}-linux-${release_arches}.tar.gz"
[ "$(basename -- "$output_path")" = "$expected_output_name" ] \
  || fail "正式发布包文件名必须是 ${expected_output_name}"
temporary_root="$(mktemp -d)"
trap 'rm -rf "$temporary_root"' EXIT
package_root="$temporary_root/raylink-${release_version}"
install -d -m 0755 "$package_root"

for runtime_arch in $release_arches; do
  case "$runtime_arch" in
    amd64|arm64) ;;
    *) fail "不支持的发布架构：$runtime_arch" ;;
  esac
  runtime_name="raylink-sing-box-${runtime_version}-linux-${runtime_arch}"
  runtime_artifact="$source_root/web/node/runtime/$runtime_name"
  runtime_checksum="${runtime_artifact}.sha256"
  cronet_name="raylink-libcronet-${runtime_version}-linux-${runtime_arch}.so"
  cronet_artifact="$source_root/web/node/runtime/$cronet_name"
  cronet_checksum="${cronet_artifact}.sha256"
  [ -f "$runtime_artifact" ] && [ -f "$runtime_checksum" ] \
    && [ -f "$cronet_artifact" ] && [ -f "$cronet_checksum" ] \
    || fail "缺少 linux-${runtime_arch} 预编译 Runtime、Cronet 依赖或校验文件"
  expected_runtime_sha256="$(awk 'NR == 1 { print $1 }' "$runtime_checksum")"
  printf '%s' "$expected_runtime_sha256" | grep -Eq '^[a-f0-9]{64}$' \
    || fail "linux-${runtime_arch} Runtime 校验文件格式错误"
  printf '%s  %s\n' "$expected_runtime_sha256" "$runtime_artifact" | sha256sum -c -
  expected_cronet_sha256="$(awk 'NR == 1 { print $1 }' "$cronet_checksum")"
  printf '%s' "$expected_cronet_sha256" | grep -Eq '^[a-f0-9]{64}$' \
    || fail "linux-${runtime_arch} Cronet 校验文件格式错误"
  printf '%s  %s\n' "$expected_cronet_sha256" "$cronet_artifact" | sha256sum -c -
done

if [ -n "$source_prefix" ]; then
  source_tree="HEAD:${source_prefix}"
else
  source_tree=HEAD
fi
git -C "$git_root" archive --format=tar "$source_tree" \
  package.json package-lock.json README.md CHANGELOG.md server web deploy docs \
  | tar -xf - -C "$package_root"

node "$package_root/deploy/prepare-runtime-dependencies.mjs" "$package_root" --install

install -d -m 0755 "$package_root/web/node/runtime"
for runtime_arch in $release_arches; do
  runtime_name="raylink-sing-box-${runtime_version}-linux-${runtime_arch}"
  install -m 0755 \
    "$source_root/web/node/runtime/$runtime_name" \
    "$package_root/web/node/runtime/$runtime_name"
  install -m 0644 \
    "$source_root/web/node/runtime/${runtime_name}.sha256" \
    "$package_root/web/node/runtime/${runtime_name}.sha256"
  cronet_name="raylink-libcronet-${runtime_version}-linux-${runtime_arch}.so"
  install -m 0644 \
    "$source_root/web/node/runtime/$cronet_name" \
    "$package_root/web/node/runtime/$cronet_name"
  install -m 0644 \
    "$source_root/web/node/runtime/${cronet_name}.sha256" \
    "$package_root/web/node/runtime/${cronet_name}.sha256"
done

candidate_path="${output_path}.candidate"
tar -czf "$candidate_path" -C "$temporary_root" "$(basename -- "$package_root")"
mv -f "$candidate_path" "$output_path"
(
  cd "$output_directory"
  sha256sum "$(basename -- "$output_path")" > "$(basename -- "$output_path").sha256"
)
node "$source_root/deploy/generate-release-metadata.mjs" \
  "$output_path" \
  "$source_root/web/node/runtime/raylink-sing-box-${runtime_version}-linux-${release_arches}" \
  "$release_version" \
  "$runtime_version" \
  "$release_arches" \
  "$source_root/web/node/runtime/raylink-libcronet-${runtime_version}-linux-${release_arches}.so" \
  "$package_root/package-lock.json"

printf 'RayLink 发布包：%s\n' "$output_path"
printf 'RayLink 发布包校验：%s.sha256\n' "$output_path"
