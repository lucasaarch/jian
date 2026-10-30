import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pngPath = join(root, 'assets', 'jian-pointer.png');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

/** The base64 a helper embeds between its opening and closing quote lines, as bytes. */
function embedded(source, opening, closing) {
  const start = source.indexOf(opening);
  assert.notEqual(start, -1, `missing ${opening.trim()}`);
  const body = source.slice(
    start + opening.length,
    source.indexOf(closing, start + opening.length),
  );
  assert.match(body, /^[A-Za-z0-9+/=\s]+$/, 'only base64 between the quotes');
  return Buffer.from(body.replace(/\s/g, ''), 'base64');
}

test('the pointer sprite ships once, for every platform, in the package', () => {
  assert.equal(existsSync(pngPath), true, 'assets/jian-pointer.png must ship in the package');
  assert.ok(readFileSync(pngPath).length > 1000, 'pointer PNG should be a real sprite');
  const files = JSON.parse(read('package.json')).files;
  assert.ok(files.includes('assets'), 'package.json must publish assets/');
});

test('macOS, Linux and Windows all draw the shipped sprite, not a stand-in of their own', () => {
  const png = readFileSync(pngPath);
  const swift = read('macos', 'computer-helper.swift');
  const linux = read('linux', 'computer-helper.py');
  const windows = read('windows', 'computer-helper.ps1');

  assert.deepEqual(embedded(swift, 'private let jianPointerPngBase64 = """\n', '\n"""'), png);
  assert.deepEqual(embedded(linux, 'JIAN_POINTER_PNG_BASE64 = """\n', '\n"""'), png);
  assert.deepEqual(embedded(windows, "$script:PointerPngBase64 = @'\n", "\n'@"), png);

  // The same 60 pt canvas with the tip at (12, 12), so the click lands where the tip is drawn.
  assert.match(swift, /pointerSize:\s*CGFloat\s*=\s*60/);
  assert.match(swift, /hotspot\s*=\s*CGPoint\(x:\s*12,\s*y:\s*12\)/);
  assert.match(linux, /^POINTER_SIZE = 60$/m);
  assert.match(linux, /^HOTSPOT = \(12, 12\)$/m);
  assert.match(windows, /\$script:PointerSize = 60/);
  assert.match(windows, /\$script:HotspotX = 12/);
  assert.match(windows, /\$script:HotspotY = 12/);

  // No geometric arrows drawn beside or instead of the bitmap.
  assert.doesNotMatch(swift, /arrowPath/);
  assert.doesNotMatch(linux, /XFillPolygon|ARROW =/);
  assert.doesNotMatch(windows, /FillPolygon|TransparencyKey/);
});

test('the overlays let clicks through to what is under the tip', () => {
  assert.match(read('linux', 'computer-helper.py'), /XShapeCombineRectangles\([^)]*ShapeInput/);
  assert.match(read('windows', 'computer-helper.ps1'), /WS_EX_TRANSPARENT/);
});
