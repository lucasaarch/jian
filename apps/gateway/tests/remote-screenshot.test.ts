import { describe, expect, it } from 'vitest';
import {
  isCompleteJpeg,
  screenshotCommand,
  validateScreenshotBase64,
} from '../src/agent/remote-tools.js';

describe('remote screenshot payload', () => {
  it('macos capture command pins primary display and recompresses before base64', () => {
    const command = screenshotCommand('macos');
    expect(command).toContain('screencapture');
    expect(command).toContain('-D 1');
    expect(command).toContain('sips');
    expect(command).toMatch(/formatOptions|quality/i);
    expect(command).toContain('base64');
    // Bound binary size so base64 stays under the worker stdout channel.
    expect(command).toMatch(/280000|300000|262144/);
  });

  it('windows capture scales and uses JPEG quality', () => {
    const command = screenshotCommand('windows');
    expect(command).toContain('image/jpeg');
    expect(command).toMatch(/Quality/);
    expect(command).toMatch(/1920|maxW|Scale/);
  });

  it('linux capture tries to shrink oversized frames when ImageMagick exists', () => {
    const command = screenshotCommand('linux');
    expect(command).toContain('base64');
    expect(command).toMatch(/convert|magick|ffmpeg/);
  });

  it('isCompleteJpeg accepts a minimal SOI…EOI buffer and rejects truncation', () => {
    const complete = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(isCompleteJpeg(complete)).toBe(true);
    expect(isCompleteJpeg(truncated)).toBe(false);
    expect(isCompleteJpeg(Buffer.alloc(0))).toBe(false);
  });

  it('validateScreenshotBase64 rejects channel-truncated grey JPEG payloads', () => {
    // Real JPEG header without EOI — the failure mode when stdout is cut at 400k chars.
    const truncated = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from('JFIF\0'),
      Buffer.alloc(64, 0x80),
    ]);
    const result = validateScreenshotBase64(truncated.toString('base64'), 400_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/truncated|incomplete|corrupt/i);
    }
  });

  it('validateScreenshotBase64 accepts a complete small JPEG under the channel cap', () => {
    // Minimal valid JPEG (SOI + empty APP0-ish + EOI is enough for our structural check).
    const complete = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const result = validateScreenshotBase64(complete.toString('base64'), 400_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes.length).toBe(4);
    }
  });

  it('validateScreenshotBase64 rejects payloads over the channel character cap', () => {
    const result = validateScreenshotBase64('A'.repeat(400_001), 400_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/too large/i);
    }
  });
});
