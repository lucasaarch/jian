import { join } from 'node:path';
import { BrowserWindow, shell } from 'electron';
import { APP_ORIGIN } from '../shared/bridge';
import { blockReloadKeys } from './app-menu';
import { submitInBrowser } from './forms';
import { resourcesDir } from './tray';
import { keepWindowState, savedPlace } from './window-state';

const MINIMUM = { width: 720, height: 520 };

/**
 * The one window. Closing it hides it: the app keeps watching its gateways from the tray, and the
 * next open shows the same panel where it was, without loading it again.
 */
export function createWindow(options: { quitting: () => boolean }): BrowserWindow {
  // Where it was left, on a screen that is still there; the first time, a size and the centre.
  const { bounds, saved } = savedPlace(MINIMUM);
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    ...bounds,
    minWidth: MINIMUM.width,
    minHeight: MINIMUM.height,
    show: false,
    title: 'Jian',
    backgroundColor: '#050505',
    // The app draws its own title bar. macOS keeps its traffic lights, inset into that bar;
    // Windows and Linux lose the system's frame, and the bar draws their buttons on the right.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } }
      : { frame: false }),
    // Windows and Linux show this in the taskbar and the window switcher; macOS takes the bundle's.
    ...(process.platform === 'darwin' ? {} : { icon: join(resourcesDir(), 'icon.png') }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  keepWindowState(window, saved);
  blockReloadKeys(window);
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (options.quitting()) return;
    event.preventDefault();
    window.hide();
  });

  // Links to the outside world open in the owner's browser, never inside the app; a form posted
  // to a new tab is posted from there too.
  window.webContents.setWindowOpenHandler(({ url, postBody }) => {
    if (postBody && url.startsWith('https:')) void submitInBrowser(url, postBody);
    else if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(APP_ORIGIN)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });

  // The title bar shows maximize or restore, whichever the window would do next.
  const maximized = () => window.webContents.send('window:maximized', window.isMaximized());
  window.on('maximize', maximized);
  window.on('unmaximize', maximized);

  void window.loadURL(`${APP_ORIGIN}/index.html`);
  return window;
}

export function reveal(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
