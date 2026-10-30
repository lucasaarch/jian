import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';

/** The app's own choices that the system does not keep for it. */
type Preferences = {
  notifications: boolean;
  /** Whether the owner was told, once, that closing the window leaves the app in the tray. */
  trayExplained: boolean;
};

const DEFAULTS: Preferences = { notifications: true, trayExplained: false };

const file = () => join(app.getPath('userData'), 'preferences.json');

/**
 * Read once, when first asked; a missing or unreadable file is the defaults. Notifications are
 * on unless the owner turned them off: replies and questions are why the app stays in the tray.
 */
let current: Preferences | undefined;

function read(): Preferences {
  if (current) return current;
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Preferences>;
    current = {
      notifications:
        typeof saved.notifications === 'boolean' ? saved.notifications : DEFAULTS.notifications,
      trayExplained:
        typeof saved.trayExplained === 'boolean' ? saved.trayExplained : DEFAULTS.trayExplained,
    };
  } catch {
    current = { ...DEFAULTS };
  }
  return current;
}

export const notificationsOn = () => read().notifications;

/** Kept in memory at once; written beside and moved over, so a quit never leaves half a file. */
async function save(change: Partial<Preferences>): Promise<void> {
  current = { ...read(), ...change };
  const next = `${file()}.next`;
  await writeFile(next, `${JSON.stringify(current)}\n`);
  await rename(next, file());
}

export const setNotifications = (on: boolean) => save({ notifications: on });

export const trayExplained = () => read().trayExplained;
export const explainedTray = () => save({ trayExplained: true });
