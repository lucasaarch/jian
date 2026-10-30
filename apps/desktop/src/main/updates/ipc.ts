import { type BrowserWindow, ipcMain } from 'electron';
import type { UpdateState } from '../../shared/updates';
import type { UpdateFlow } from './flow';

/** What the window may ask of the app's updates, and how the main process tells it of them. */
export function serveUpdates(
  updates: () => UpdateFlow | undefined,
  window: () => BrowserWindow | undefined,
): { changed(state: UpdateState): void; show(): void } {
  const send = (channel: string, value: unknown) => window()?.webContents.send(channel, value);
  ipcMain.handle('updates:state', () => updates()?.state());
  ipcMain.handle('updates:check', () => updates()?.check());
  ipcMain.on('updates:install', () => void updates()?.install());
  return {
    changed: (state) => send('updates:changed', state),
    show: () => send('updates:show', null),
  };
}
