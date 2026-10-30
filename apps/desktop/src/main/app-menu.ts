import { app, type BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * The menu bar, without Electron's Reload and Force Reload: reloading drops the panel's place
 * and every open connection, so it is the command palette's animated Reload App, never a key
 * pressed by accident. macOS keeps its Edit menu — copy and paste answer to it there — and the
 * developer tools stay reachable from source only. Windows and Linux draw no menu bar.
 */
export function setAppMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const view: MenuItemConstructorOptions[] = [
    ...(app.isPackaged
      ? []
      : [{ role: 'toggleDevTools' } as const, { type: 'separator' } as const]),
    { role: 'togglefullscreen' },
  ];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { label: 'View', submenu: view },
      { role: 'windowMenu' },
    ]),
  );
}

/** Whether a key press is one a browser reloads on: ⌘R or Ctrl+R, with shift or not, and F5. */
function reloads(input: Electron.Input): boolean {
  if (input.type !== 'keyDown') return false;
  if (input.key === 'F5') return true;
  const modifier = process.platform === 'darwin' ? input.meta : input.control;
  return modifier && !input.alt && input.key.toLowerCase() === 'r';
}

/** Keeps the reload keys from the window, which Chromium would answer even without a menu. */
export function blockReloadKeys(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (reloads(input)) event.preventDefault();
  });
}
