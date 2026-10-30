#!/usr/bin/env bash
# Builds the Windows computer-helper the npm package ships, one per CPU, into
# native/bin/windows/ by default: computer-helper-x64.exe and computer-helper-arm64.exe, named
# after Node's process.arch. Needs rustup with both MSVC targets.
#
# On Windows — Git Bash on GitHub's windows-latest — it builds with MSVC; the x64 runner's
# Visual Studio has the ARM64 build tools for the second target. On macOS or Linux it
# cross-builds through cargo-xwin (`cargo install cargo-xwin`), which downloads the MSVC CRT
# and Windows SDK on first use; set XWIN_ACCEPT_LICENSE=1 to accept Microsoft's license.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/bin/windows}"
# The workspace's target directory, unless CARGO_TARGET_DIR moves it.
TARGET_DIR="${CARGO_TARGET_DIR:-$(cd "$HERE/../../.." && pwd)/target}"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) build=(cargo build) ;;
  *)
    if ! cargo xwin --version >/dev/null 2>&1; then
      echo "build-windows.sh needs Windows, or cargo-xwin to cross-build: cargo install cargo-xwin" >&2
      exit 1
    fi
    build=(cargo xwin build)
    ;;
esac

# The C runtime linked in, so the helper runs without the Visual C++ Redistributable.
export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS="-C target-feature=+crt-static"
export CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_RUSTFLAGS="-C target-feature=+crt-static"

mkdir -p "$OUT"
for pair in x86_64-pc-windows-msvc:x64 aarch64-pc-windows-msvc:arm64; do
  target="${pair%%:*}"
  arch="${pair##*:}"
  "${build[@]}" --release --locked --manifest-path "$HERE/Cargo.toml" --target "$target"
  cp "$TARGET_DIR/$target/release/computer-helper.exe" "$OUT/computer-helper-$arch.exe"
  echo "Built $arch helper: $OUT/computer-helper-$arch.exe"
done
