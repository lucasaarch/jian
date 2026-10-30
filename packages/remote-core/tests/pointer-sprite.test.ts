import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pngPath = join(packageRoot, 'native', 'jian-pointer.png');
const native = (path: string) =>
  readFileSync(join(packageRoot, 'native/src/platform', path), 'utf8');

test('the pointer sprite is kept once, for every platform, beside the helpers', () => {
  assert.equal(existsSync(pngPath), true, 'native/jian-pointer.png must exist');
  assert.ok(readFileSync(pngPath).length > 1000, 'pointer PNG should be a real sprite');
});

test('macOS, Linux and Windows all draw the shipped sprite, not a stand-in of their own', () => {
  const rust = readFileSync(join(packageRoot, 'native/src/platform/macos/pointer.rs'), 'utf8');
  const linux = native('linux/sprite.rs');
  const windows = readFileSync(join(packageRoot, 'native/src/platform/windows/pointer.rs'), 'utf8');
  const windowsCanvas = readFileSync(
    join(packageRoot, 'native/src/platform/windows/canvas.rs'),
    'utf8',
  );

  // The Rust helper embeds the file itself at build time.
  assert.match(rust, /include_bytes!\("(?:\.\.\/)+jian-pointer\.png"\)/);
  assert.match(linux, /include_bytes!\("(?:\.\.\/)+jian-pointer\.png"\)/);
  assert.match(windows, /include_bytes!\("(?:\.\.\/)+jian-pointer\.png"\)/);

  // The same 60 pt canvas with the tip at (12, 12), so the click lands where the tip is drawn.
  assert.match(rust, /const SIZE: f64 = 60\.0;/);
  assert.match(rust, /const HOTSPOT: CGPoint = CGPoint \{ x: 12\.0, y: 12\.0 \};/);
  assert.match(linux, /const SIZE: u16 = 60;/);
  assert.match(linux, /const HOTSPOT: \(i16, i16\) = \(12, 12\);/);
  assert.match(windowsCanvas, /const SIZE: f64 = 60\.0;/);
  assert.match(windowsCanvas, /const HOTSPOT: \(f64, f64\) = \(12\.0, 12\.0\);/);

  // No geometric arrows drawn beside or instead of the bitmap.
  assert.doesNotMatch(linux + native('linux/pointer.rs'), /fill_poly|poly_fill/);
  assert.doesNotMatch(windows + windowsCanvas, /Polygon|COLORKEY/);
});

test('the overlays let clicks through to what is under the tip', () => {
  // An empty input shape: the X server routes no click to the pointer's window.
  assert.match(native('linux/pointer.rs'), /shape::rectangles\([^;]*SK::INPUT[^;]*&\[\]/);
  assert.match(
    readFileSync(join(packageRoot, 'native/src/platform/windows/overlay.rs'), 'utf8'),
    /WS_EX_LAYERED[^;]*WS_EX_TRANSPARENT/,
  );
});
