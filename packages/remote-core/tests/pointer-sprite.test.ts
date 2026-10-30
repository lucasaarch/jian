import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(packageRoot, 'helpers');
const pngPath = join(root, 'assets', 'jian-pointer.png');
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8');

/** The base64 a helper embeds between its opening and closing quote lines, as bytes. */
function embedded(source: string, opening: string, closing: string): Buffer {
  const start = source.indexOf(opening);
  assert.notEqual(start, -1, `missing ${opening.trim()}`);
  const body = source.slice(
    start + opening.length,
    source.indexOf(closing, start + opening.length),
  );
  assert.match(body, /^[A-Za-z0-9+/=\s]+$/, 'only base64 between the quotes');
  return Buffer.from(body.replace(/\s/g, ''), 'base64');
}

test('the pointer sprite is kept once, for every platform, beside the helpers', () => {
  assert.equal(existsSync(pngPath), true, 'helpers/assets/jian-pointer.png must exist');
  assert.ok(readFileSync(pngPath).length > 1000, 'pointer PNG should be a real sprite');
});

test('macOS, Linux and Windows all draw the shipped sprite, not a stand-in of their own', () => {
  const png = readFileSync(pngPath);
  const rust = readFileSync(join(packageRoot, 'native/src/platform/macos/pointer.rs'), 'utf8');
  const linux = read('linux', 'computer-helper.py');
  const windows = read('windows', 'computer-helper.ps1');

  // The Rust helper embeds the file itself at build time.
  assert.match(rust, /include_bytes!\("(?:\.\.\/)+helpers\/assets\/jian-pointer\.png"\)/);
  assert.deepEqual(embedded(linux, 'JIAN_POINTER_PNG_BASE64 = """\n', '\n"""'), png);
  assert.deepEqual(embedded(windows, "$script:PointerPngBase64 = @'\n", "\n'@"), png);

  // The same 60 pt canvas with the tip at (12, 12), so the click lands where the tip is drawn.
  assert.match(rust, /const SIZE: f64 = 60\.0;/);
  assert.match(rust, /const HOTSPOT: CGPoint = CGPoint \{ x: 12\.0, y: 12\.0 \};/);
  assert.match(linux, /^POINTER_SIZE = 60$/m);
  assert.match(linux, /^HOTSPOT = \(12, 12\)$/m);
  assert.match(windows, /\$script:PointerSize = 60/);
  assert.match(windows, /\$script:HotspotX = 12/);
  assert.match(windows, /\$script:HotspotY = 12/);

  // No geometric arrows drawn beside or instead of the bitmap.
  assert.doesNotMatch(linux, /XFillPolygon|ARROW =/);
  assert.doesNotMatch(windows, /FillPolygon|TransparencyKey/);
});

test('the overlays let clicks through to what is under the tip', () => {
  assert.match(read('linux', 'computer-helper.py'), /XShapeCombineRectangles\([^)]*ShapeInput/);
  assert.match(read('windows', 'computer-helper.ps1'), /WS_EX_TRANSPARENT/);
});
