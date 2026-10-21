/**
 * Shared computer-use helpers: coords, capabilities, motion easing.
 * Platform backends live in computer-{macos,linux,windows}.mjs.
 */

export const COMPUTER_CAPABILITIES = Object.freeze({
  darwin: 'computer-macos-v1',
  linux: 'computer-linux-v1',
  win32: 'computer-windows-v1',
});

const CAPABILITY_SET = new Set(Object.values(COMPUTER_CAPABILITIES));

/** True when a worker capability string means remote_computer is supported. */
export function isComputerCapability(value) {
  return CAPABILITY_SET.has(value);
}

export function capabilityForPlatform(platform = process.platform) {
  return COMPUTER_CAPABILITIES[platform] ?? null;
}

/** Map screenshot image pixels → display points (primary). Half-pixel centers the click. */
export function imagePixelToPoint(x, y, geometry) {
  const { originX, originY, pointWidth, pointHeight, widthPx, heightPx } = geometry;
  if (!(widthPx > 0 && heightPx > 0 && pointWidth > 0 && pointHeight > 0)) {
    throw new Error('Invalid screenshot geometry for coordinate mapping');
  }
  return {
    pointX: originX + (x + 0.5) * (pointWidth / widthPx),
    pointY: originY + (y + 0.5) * (pointHeight / heightPx),
  };
}

export function scaleFromGeometry(geometry) {
  return {
    imageToPointX: geometry.pointWidth / geometry.widthPx,
    imageToPointY: geometry.pointHeight / geometry.heightPx,
  };
}

/** Ease-out cubic — snappy agent loops, still readable as motion. */
export function easeOutCubic(t) {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

/**
 * Duration (ms) for overlay travel. Caps keep agent loops fast on long jumps.
 * ~0.25 ms/px with floor 28 ms / ceiling 110 ms.
 */
export function motionDurationMs(distancePx) {
  const d = Math.max(0, distancePx);
  return Math.round(Math.min(110, Math.max(28, d * 0.25)));
}

export function pointDistance(a, b) {
  const dx = (b.pointX ?? b.x) - (a.pointX ?? a.x);
  const dy = (b.pointY ?? b.y) - (a.pointY ?? a.y);
  return Math.hypot(dx, dy);
}
