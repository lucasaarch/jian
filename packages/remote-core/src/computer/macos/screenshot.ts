import { spawnSync } from 'node:child_process';
import type { Screenshot } from '../session.ts';

/**
 * Captures the primary display and fits it to the worker channel in one shell: the first pass
 * is already 1600 px at quality 42, because a full-resolution Retina capture nearly always went
 * over budget and cost a second sips pass. Smaller steps follow only while still over 280 KB.
 * It prints the pixel size on one line, then the image as base64.
 */
const CAPTURE_SCRIPT = [
  'tmp=$(mktemp /tmp/jian-shot.XXXXXX.jpg);',
  'screencapture -x -t jpg -D 1 "$tmp" || { rm -f "$tmp"; exit 1; };',
  'sips -Z 1600 -s format jpeg -s formatOptions 42 "$tmp" >/dev/null 2>&1 || true;',
  'size=$(wc -c < "$tmp" | tr -d " ");',
  'if [ "$size" -gt 280000 ]; then sips -Z 1440 -s format jpeg -s formatOptions 38 "$tmp" >/dev/null 2>&1 || true; fi;',
  'size=$(wc -c < "$tmp" | tr -d " ");',
  'if [ "$size" -gt 280000 ]; then sips -Z 1280 -s format jpeg -s formatOptions 34 "$tmp" >/dev/null 2>&1 || true; fi;',
  'w=$(sips -g pixelWidth "$tmp" 2>/dev/null | awk "/pixelWidth/{print \\$2}");',
  'h=$(sips -g pixelHeight "$tmp" 2>/dev/null | awk "/pixelHeight/{print \\$2}");',
  'echo "$w $h";',
  'base64 < "$tmp";',
  'rm -f "$tmp"',
].join(' ');

/** Throws with a Screen Recording hint when macOS refused the capture. */
export function capturePrimaryScreenshotBase64(): Screenshot {
  const result = spawnSync('/bin/sh', ['-lc', CAPTURE_SCRIPT], {
    encoding: 'utf8',
    maxBuffer: 600_000,
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').trim();
    throw new Error(
      /not authorized|capture/i.test(err)
        ? 'Jian Remote needs Screen Recording permission in System Settings.'
        : err || 'Screenshot failed',
    );
  }
  const out = result.stdout || '';
  const newline = out.indexOf('\n');
  if (newline < 0) throw new Error('Screenshot produced no image data.');
  const [widthPx = Number.NaN, heightPx = Number.NaN] = out
    .slice(0, newline)
    .trim()
    .split(/\s+/)
    .map(Number);
  if (!(widthPx >= 1 && heightPx >= 1)) throw new Error('Could not read screenshot dimensions.');
  const base64 = out.slice(newline + 1).replace(/\s+/g, '');
  if (!base64) throw new Error('Screenshot produced no image data.');
  return { base64, widthPx, heightPx };
}
