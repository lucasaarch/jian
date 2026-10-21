import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const macosDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'macos');
const swiftPath = join(macosDir, 'computer-helper.swift');
const pngPath = join(macosDir, 'jian-pointer.png');

test('macos ships jian-pointer.png and embeds it as base64 in computer-helper.swift', () => {
  assert.equal(existsSync(pngPath), true, 'macos/jian-pointer.png must ship in the package');
  assert.equal(existsSync(swiftPath), true);
  const swift = readFileSync(swiftPath, 'utf8');
  const png = readFileSync(pngPath);
  assert.ok(png.length > 1000, 'pointer PNG should be a real sprite');
  const encoded = swift.match(
    /private let jianPointerPngBase64 = """\n([A-Za-z0-9+/=\n]+)\n"""/,
  )?.[1];
  assert.ok(encoded, 'Swift must embed the sprite');
  const embedded = Buffer.from(encoded.replaceAll('\n', ''), 'base64');
  assert.deepEqual(embedded, png, 'embedded sprite must match the shipped PNG');
  assert.match(swift, /pointerSize:\s*CGFloat\s*=\s*60/);
  assert.match(swift, /hotspot\s*=\s*CGPoint\(x:\s*12,\s*y:\s*12\)/);
  assert.doesNotMatch(swift, /arrowPath/);
  assert.doesNotMatch(swift, /pointerWhite/);
  // Stroke token from approved preview.
  assert.match(swift, /0x28\s*\/\s*255.*0x80\s*\/\s*255.*0xF8\s*\/\s*255/s);
});

test('linux and windows overlays use white fill and #2880F8 for cursor parity', () => {
  const linux = readFileSync(join(macosDir, '..', 'linux', 'computer-helper.py'), 'utf8');
  const windows = readFileSync(join(macosDir, '..', 'windows', 'computer-helper.ps1'), 'utf8');
  assert.match(linux, /#FFFFFF/);
  assert.match(linux, /#2880F8/);
  assert.doesNotMatch(linux, /#171716/);
  assert.match(windows, /255,\s*255,\s*255,\s*255/);
  assert.match(windows, /40,\s*128,\s*248/);
});
