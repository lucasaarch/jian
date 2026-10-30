import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateCheck } from '../shared/bridge';

/** How often a running app looks for a new release, in ms. */
const EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * The app keeps itself on the latest release from GitHub: it downloads in the background and
 * installs on the next quit, with a system notification saying so. A build from source has no
 * release to compare with and never looks.
 */
export function keepUpdated(): void {
  if (!app.isPackaged) return;
  const { autoUpdater } = electronUpdater;
  const check = () => void autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  check();
  setInterval(check, EVERY_MS).unref();
}

/** Asked for now, from the command palette: what the owner reads in answer. */
export async function checkNow(): Promise<UpdateCheck> {
  if (!app.isPackaged) return { state: 'unavailable' };
  try {
    const result = await electronUpdater.autoUpdater.checkForUpdatesAndNotify();
    const latest = result?.updateInfo.version;
    if (!latest || !result?.isUpdateAvailable)
      return { state: 'latest', version: app.getVersion() };
    // Downloading has started; the system notification says when it is ready to install.
    return { state: 'available', version: latest };
  } catch (error) {
    return { state: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
