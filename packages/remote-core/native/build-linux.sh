#!/usr/bin/env bash
# Builds the Linux computer-helper the npm package ships, one static binary per CPU, into
# native/bin/linux/ by default: computer-helper-x64 and computer-helper-arm64, named after
# Node's process.arch. Runs on macOS and Linux alike, with no Docker and no C toolchain.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/bin/linux}"

if ! command -v rustup >/dev/null; then
  echo "build-linux.sh needs rustup (https://rustup.rs)." >&2
  exit 1
fi

# musl, linked statically: the binary needs no libc, libX11 or libxcb from the distro it runs
# on. Every dependency is pure Rust, so nothing needs a C cross compiler, and rust-lld, which
# ships with every rustup toolchain, links both targets from any host.
TARGETS=(x86_64-unknown-linux-musl aarch64-unknown-linux-musl)
rustup target add "${TARGETS[@]}" >/dev/null
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld

for target in "${TARGETS[@]}"; do
  cargo build --release --locked --manifest-path "$HERE/Cargo.toml" --target "$target"
done

TARGET_DIR="$(cargo metadata --format-version 1 --no-deps --manifest-path "$HERE/Cargo.toml" \
  | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')"
mkdir -p "$OUT_DIR"
# The release profile strips symbols already; the copy only renames to Node's CPU names.
install -m 755 "$TARGET_DIR/x86_64-unknown-linux-musl/release/computer-helper" \
  "$OUT_DIR/computer-helper-x64"
install -m 755 "$TARGET_DIR/aarch64-unknown-linux-musl/release/computer-helper" \
  "$OUT_DIR/computer-helper-arm64"

echo "Built Linux helpers in $OUT_DIR"
if command -v file >/dev/null; then
  file "$OUT_DIR/computer-helper-x64" "$OUT_DIR/computer-helper-arm64"
fi
