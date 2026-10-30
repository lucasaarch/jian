import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, type BrowserWindow, screen } from 'electron';
import { type Bounds, placeWindow, readState, type WindowState } from './window-place';

/** How long the window rests after a move or a resize before where it is gets written. */
const SETTLE_MS = 500;

const file = () => join(app.getPath('userData'), 'window-state.json');

/**
 * Where the window opens, from where it was left. Read once, before the window exists, so it
 * opens in place rather than moving there after it shows.
 */
export function savedPlace(minimum: { width: number; height: number }): {
  bounds: Partial<Bounds>;
  saved: WindowState | undefined;
} {
  let saved: WindowState | undefined;
  try {
    saved = readState(JSON.parse(readFileSync(file(), 'utf8')));
  } catch {
    saved = undefined;
  }
  const screens = [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map(
    (display) => display.workArea,
  );
  return { bounds: placeWindow(saved, screens, minimum), saved };
}

/**
 * Writes where the window is as it moves, resizes, fills the screen or leaves it. A maximized
 * or full-screen window keeps the size it returns to, so unmaximizing after a restart lands
 * where it was before.
 */
export function keepWindowState(window: BrowserWindow, saved: WindowState | undefined): void {
  // Before it shows, not now: maximizing a hidden window would show it before it is drawn.
  window.once('ready-to-show', () => {
    if (saved?.maximized) window.maximize();
    if (saved?.fullScreen) window.setFullScreen(true);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  // Written beside and moved over, so a quit halfway through never leaves half a file. Not kept
  // when that fails: the window opens where it was last written.
  const write = (now = false) => {
    clearTimeout(timer);
    if (window.isDestroyed()) return;
    const state: WindowState = {
      ...window.getNormalBounds(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    };
    const text = `${JSON.stringify(state)}\n`;
    const next = `${file()}.next`;
    if (now) {
      try {
        writeFileSync(next, text);
        renameSync(next, file());
      } catch {}
      return;
    }
    void writeFile(next, text)
      .then(() => rename(next, file()))
      .catch(() => {});
  };
  const settle = () => {
    clearTimeout(timer);
    timer = setTimeout(write, SETTLE_MS);
  };

  window.on('resize', settle);
  window.on('move', settle);
  window.on('maximize', () => write());
  window.on('unmaximize', () => write());
  window.on('enter-full-screen', () => write());
  window.on('leave-full-screen', () => write());
  // Hiding into the tray and quitting both pass through here, and a quit does not wait for a
  // write in flight: this one is done before it goes on.
  window.on('close', () => write(true));
}
