/**
 * What every Computer Use backend shares: the capability each platform advertises, and how a
 * pixel of the last screenshot becomes a point the OS addresses input to.
 */

export const COMPUTER_CAPABILITIES = Object.freeze({
  darwin: 'computer-macos-v1',
  linux: 'computer-linux-v1',
  win32: 'computer-windows-v1',
} as const);

export type ComputerCapability = (typeof COMPUTER_CAPABILITIES)[keyof typeof COMPUTER_CAPABILITIES];

const CAPABILITY_SET: ReadonlySet<string> = new Set(Object.values(COMPUTER_CAPABILITIES));

/** True when a worker capability string means remote_computer is supported. */
export function isComputerCapability(value: unknown): value is ComputerCapability {
  return typeof value === 'string' && CAPABILITY_SET.has(value);
}

/** Own keys only, so a platform named like an Object.prototype member maps to nothing. */
export function capabilityForPlatform(
  platform: string = process.platform,
): ComputerCapability | null {
  return Object.hasOwn(COMPUTER_CAPABILITIES, platform)
    ? COMPUTER_CAPABILITIES[platform as keyof typeof COMPUTER_CAPABILITIES]
    : null;
}

/**
 * The primary display in points — the unit input events address — and its origin in the
 * global desktop space. Retina and fractional scaling make points and pixels differ.
 */
export type DisplayGeometry = {
  originX: number;
  originY: number;
  pointWidth: number;
  pointHeight: number;
};

/** The display, and the pixel size of the screenshot the agent is looking at. */
export type ShotGeometry = DisplayGeometry & { widthPx: number; heightPx: number };

export type DisplayPoint = { pointX: number; pointY: number };

/** Screenshot pixel → display point. The half pixel aims at the pixel's center, not its corner. */
export function imagePixelToPoint(x: number, y: number, geometry: ShotGeometry): DisplayPoint {
  const { originX, originY, pointWidth, pointHeight, widthPx, heightPx } = geometry;
  if (!(widthPx > 0 && heightPx > 0 && pointWidth > 0 && pointHeight > 0)) {
    throw new Error('Invalid screenshot geometry for coordinate mapping');
  }
  return {
    pointX: originX + (x + 0.5) * (pointWidth / widthPx),
    pointY: originY + (y + 0.5) * (pointHeight / heightPx),
  };
}

/** Points per screenshot pixel, told to the agent beside each screenshot. */
export function scaleFromGeometry(
  geometry: Pick<ShotGeometry, 'pointWidth' | 'pointHeight' | 'widthPx' | 'heightPx'>,
): { imageToPointX: number; imageToPointY: number } {
  return {
    imageToPointX: geometry.pointWidth / geometry.widthPx,
    imageToPointY: geometry.pointHeight / geometry.heightPx,
  };
}
