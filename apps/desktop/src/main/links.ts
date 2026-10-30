import { resolve } from 'node:path';
import { app } from 'electron';

/**
 * Makes this app the one the system opens jian:// links with. From source the app is Electron
 * running this project, so the system is told to pass the project along.
 */
export function claimLinks(): void {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient('jian', process.execPath, [resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('jian');
  }
}
