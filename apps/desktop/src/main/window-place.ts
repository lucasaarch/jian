/** A rectangle on the desktop, in the system's points. */
export type Bounds = { x: number; y: number; width: number; height: number };

/** How the window was left: where and how large, and whether it filled the screen. */
export type WindowState = Bounds & { maximized: boolean; fullScreen: boolean };

/** How much of a saved window must still be on a screen to open there: enough to grab it. */
const VISIBLE = 64;

const overlap = (a: Bounds, b: Bounds) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) >= VISIBLE &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) >= VISIBLE;

/** A saved state, as far as it can be read; anything else is no state at all. */
export function readState(value: unknown): WindowState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Record<string, unknown>;
  const numbers = ['x', 'y', 'width', 'height'].map((key) => state[key]);
  if (!numbers.every((number) => typeof number === 'number' && Number.isFinite(number))) {
    return undefined;
  }
  const [x, y, width, height] = numbers as number[];
  return {
    x: x as number,
    y: y as number,
    width: width as number,
    height: height as number,
    maximized: state.maximized === true,
    fullScreen: state.fullScreen === true,
  };
}

/**
 * Where the window opens: where it was left, when that is still on one of the screens; on a
 * screen that is gone — a display unplugged — it keeps its size, as far as the main screen
 * holds it, and the system centres it.
 */
export function placeWindow(
  saved: WindowState | undefined,
  screens: Bounds[],
  minimum: { width: number; height: number },
): Partial<Bounds> {
  if (!saved) return {};
  const width = Math.max(saved.width, minimum.width);
  const height = Math.max(saved.height, minimum.height);
  if (screens.some((screen) => overlap({ ...saved, width, height }, screen))) {
    return { x: saved.x, y: saved.y, width, height };
  }
  const main = screens[0];
  return main
    ? { width: Math.min(width, main.width), height: Math.min(height, main.height) }
    : { width, height };
}
