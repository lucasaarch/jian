#!/usr/bin/env bash
# Builds the universal (arm64 + x86_64) macOS computer-helper the npm package ships, into
# helpers/macos/ by default. Needs rustup with both Apple targets; Publish CI runs it too.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/../helpers/macos/computer-helper}"
# The oldest macOS the helper runs on; AppKit and CoreGraphics calls it makes exist since.
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-macos.sh must run on macOS (lipo, codesign)." >&2
  exit 1
fi

for target in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo build --release --locked --manifest-path "$HERE/Cargo.toml" --target "$target"
done

TARGET_DIR="$(cargo metadata --format-version 1 --no-deps --manifest-path "$HERE/Cargo.toml" \
  | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')"
mkdir -p "$(dirname "$OUT")"
lipo -create -output "$OUT" \
  "$TARGET_DIR/aarch64-apple-darwin/release/computer-helper" \
  "$TARGET_DIR/x86_64-apple-darwin/release/computer-helper"
chmod 755 "$OUT"

# Ad-hoc, so launchd children run it without Gatekeeper prompts; Publish signs over this with
# a Developer ID when its secrets exist.
codesign --force -s - --identifier com.jian.remote.computer-helper "$OUT"

echo "Built universal helper: $OUT"
lipo -info "$OUT"
