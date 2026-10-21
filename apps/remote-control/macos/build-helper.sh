#!/usr/bin/env bash
# Build a universal (arm64 + x86_64) computer-helper for the npm package.
# Run on macOS with Xcode CLT. Used by Publish CI and local packaging.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/computer-helper.swift"
OUT="${1:-$ROOT/computer-helper}"
MIN_OS="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/jian-computer-helper.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-helper.sh must run on macOS (swiftc + lipo)." >&2
  exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install Xcode Command Line Tools." >&2
  exit 1
fi
if [[ ! -f "$SRC" ]]; then
  echo "Missing source: $SRC" >&2
  exit 1
fi

swiftc -O \
  -target "arm64-apple-macosx${MIN_OS}" \
  -framework AppKit -framework Carbon \
  -o "$TMP/computer-helper-arm64" "$SRC"

swiftc -O \
  -target "x86_64-apple-macosx${MIN_OS}" \
  -framework AppKit -framework Carbon \
  -o "$TMP/computer-helper-x86_64" "$SRC"

lipo -create -output "$OUT" "$TMP/computer-helper-arm64" "$TMP/computer-helper-x86_64"
chmod 755 "$OUT"

# Ad-hoc sign so Gatekeeper is quieter for LaunchAgent children; Developer ID overlays this in CI when secrets exist.
if command -v codesign >/dev/null 2>&1; then
  codesign --force -s - --identifier com.jian.remote.computer-helper "$OUT" 2>/dev/null || true
fi

echo "Built universal helper: $OUT"
lipo -info "$OUT"
