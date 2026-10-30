import { join } from 'node:path';
import { BrowserWindow, shell } from 'electron';
import { APP_ORIGIN } from '../shared/bridge';
import { submitInBrowser } from './forms';
import { resourcesDir } from './tray';

/**
 * The one window. Closing it hides it: the app keeps watching its gateways from the tray, and the
 * next open shows the same panel where it was, without loading it again.
 */
export function createWindow(options: { quitting: () => boolean }): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'Jian',
    // The app draws its own title bar. macOS keeps its traffic lights, inset into that bar;
    // Windows and Linux lose the system's frame, and the bar draws their buttons on the right.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 13 },
          // The desktop shows through, blurred by the system, under the app's glass.
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000',
        }
      : { frame: false, backgroundColor: '#050505' }),
    // Windows and Linux show this in the taskbar and the window switcher; macOS takes the bundle's.
    ...(process.platform === 'darwin' ? {} : { icon: join(resourcesDir(), 'icon.png') }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

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
