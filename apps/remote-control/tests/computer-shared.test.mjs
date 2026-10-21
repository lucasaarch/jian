import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COMPUTER_CAPABILITIES,
  capabilityForPlatform,
  easeOutCubic,
  imagePixelToPoint,
  isComputerCapability,
  motionDurationMs,
  pointDistance,
  scaleFromGeometry,
} from '../bin/computer-shared.mjs';

describe('computer-shared', () => {
  it('maps capabilities per platform', () => {
    assert.equal(capabilityForPlatform('darwin'), 'computer-macos-v1');
    assert.equal(capabilityForPlatform('linux'), 'computer-linux-v1');
    assert.equal(capabilityForPlatform('win32'), 'computer-windows-v1');
    assert.equal(capabilityForPlatform('freebsd'), null);
    assert.ok(isComputerCapability(COMPUTER_CAPABILITIES.darwin));
    assert.ok(isComputerCapability('computer-linux-v1'));
    assert.ok(isComputerCapability('computer-windows-v1'));
    assert.equal(isComputerCapability('shell'), false);
  });

  it('maps image pixels into display points with half-pixel centering', () => {
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
  });

  it('exposes image-to-point scale factors', () => {
    assert.deepEqual(
      scaleFromGeometry({ pointWidth: 1000, pointHeight: 500, widthPx: 2000, heightPx: 1000 }),
      { imageToPointX: 0.5, imageToPointY: 0.5 },
    );
  });

  it('eases motion and clamps duration for snappy agent loops', () => {
    assert.equal(easeOutCubic(0), 0);
    assert.equal(easeOutCubic(1), 1);
    assert.ok(easeOutCubic(0.5) > 0.5);
    assert.equal(motionDurationMs(0), 28);
    assert.equal(motionDurationMs(40), 28);
    assert.ok(motionDurationMs(200) > 28);
    assert.equal(motionDurationMs(10_000), 110);
    assert.ok(
      Math.abs(pointDistance({ pointX: 0, pointY: 0 }, { pointX: 3, pointY: 4 }) - 5) < 1e-9,
    );
  });
});
