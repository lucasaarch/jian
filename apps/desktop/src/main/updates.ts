import { app } from 'electron';
import electronUpdater from 'electron-updater';

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
