import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pngPath = join(packageRoot, 'native', 'jian-pointer.png');
const native = (path: string) => readFileSync(join(packageRoot, 'native/src', path), 'utf8');

test("the sprite the desktop app's browser pointer draws stays where it imports it from", () => {
  assert.equal(existsSync(pngPath), true, 'native/jian-pointer.png must exist');
  assert.ok(readFileSync(pngPath).length > 1000, 'pointer PNG should be a real sprite');
});

test('macOS, Linux and Windows all draw the one shared pointer, not a stand-in of their own', () => {
  const pointers = ['macos', 'linux', 'windows'].map((os) => native(`platform/${os}/pointer.rs`));

  for (const pointer of pointers) {
    // The dart comes from the shared drawing, in the look the session was opened with.
    assert.match(pointer, /Art::draw\(\s*(?:self\.)?look\.color,/);
    // No sprite embedded beside it, and no outline drawn by the platform.
    assert.doesNotMatch(pointer, /include_bytes!|fill_poly|poly_fill|Polygon|COLORKEY/);
  }

  // One tip for every platform, so the click lands where the tip is drawn.
  const cursor = native('cursor.rs');
  assert.match(cursor, /pub const TIP: f64 = 24\.0;/);
  for (const pointer of pointers) assert.match(pointer, /art\.tip\(\)/);
});

test('each session has a pointer of its own, named and coloured by the worker', () => {
  assert.match(native('main.rs'), /pointers: HashMap<String, \(Look, Q\)>/);
  assert.match(
    native('protocol.rs'),
    /EnsureSession \{\s*label: Option<String>,\s*color: Option<String>,/,
  );
});

test('the overlays let clicks through to what is under the tip', () => {
  // An empty input shape: the X server routes no click to the pointer's window.
  assert.match(native('platform/linux/pointer.rs'), /shape::rectangles\([^;]*SK::INPUT[^;]*&\[\]/);
  assert.match(native('platform/windows/overlay.rs'), /WS_EX_LAYERED[^;]*WS_EX_TRANSPARENT/);
  assert.match(native('platform/macos/pointer.rs'), /setIgnoresMouseEvents\(true\)/);
});
