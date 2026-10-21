import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { imagePixelToPoint, scaleFromGeometry } from '../bin/computer-macos.mjs';

describe('computer-use coordinate mapping', () => {
  it('maps image pixels into primary display points with half-pixel centering', () => {
    const geometry = {
      originX: 0,
      originY: 0,
      pointWidth: 1440,
      pointHeight: 900,
      widthPx: 1920,
      heightPx: 1200,
    };
    const origin = imagePixelToPoint(0, 0, geometry);
    assert.equal(origin.pointX, 0.5 * (1440 / 1920));
    assert.equal(origin.pointY, 0.5 * (900 / 1200));

    const mid = imagePixelToPoint(959, 599, geometry);
    assert.ok(Math.abs(mid.pointX - ((959 + 0.5) * 1440) / 1920) < 1e-9);
    assert.ok(Math.abs(mid.pointY - ((599 + 0.5) * 900) / 1200) < 1e-9);
  });

  it('exposes image-to-point scale factors for the agent', () => {
    const scale = scaleFromGeometry({
      pointWidth: 1000,
      pointHeight: 500,
      widthPx: 2000,
      heightPx: 1000,
    });
    assert.deepEqual(scale, { imageToPointX: 0.5, imageToPointY: 0.5 });
  });
});
