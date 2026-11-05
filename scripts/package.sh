#!/bin/sh
# Packs each build in dist/ as the file people download, in dist/release/:
# `swarmfu` (or `swarmfu.exe`) inside a .zip for macOS and Windows, a .tar.gz
# for Linux. A browser saves a bare binary without its execute bit; an archive
# keeps it, and gives the program its plain name.
set -eu
out="$(pwd)/dist/release"
rm -rf "$out"
mkdir -p "$out"
for bin in dist/swarmfu-*; do
  [ -f "$bin" ] || continue
  case "$bin" in *.map|*.zip|*.tar.gz) continue ;; esac
  file=$(basename "$bin" .exe)                      # swarmfu-minecraft-darwin-arm64
  ext=""; [ "$file" = "$(basename "$bin")" ] || ext=".exe"
  target=$(echo "$file" | sed -E 's/^swarmfu(-minecraft)?-//')
  name="${file%-"$target"}"                         # swarmfu or swarmfu-minecraft
  stage=$(mktemp -d)
  cp "$bin" "$stage/$name$ext"
  chmod +x "$stage/$name$ext"
  case "$target" in
    linux-*) tar -czf "$out/$file.tar.gz" -C "$stage" "$name$ext" ;;
    *) (cd "$stage" && zip -q "$out/$file.zip" "$name$ext") ;;
  esac
  rm -rf "$stage"
done
ls -l "$out"
