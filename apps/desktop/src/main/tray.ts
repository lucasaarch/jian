import { join } from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';

/**
 * The app's place while its window is closed: open it again, or quit for real. On macOS the icon
 * is a template, which the menu bar tints for light and dark.
 */
export function createTray(actions: { open(): void; quit(): void }): Tray {
  const name = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const tray = new Tray(nativeImage.createFromPath(join(resourcesDir(), name)));
  tray.setToolTip('Jian');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Jian', click: actions.open },
      { type: 'separator' },
      { label: 'Quit Jian', click: actions.quit },
    ]),
  );
  // Windows and Linux open the window on a click; macOS shows the menu, as its menu bar does.
  if (process.platform !== 'darwin') tray.on('click', actions.open);
  return tray;
}

/** The app's own images: beside the build in development, in the package's resources when packaged. */
export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(import.meta.dirname, '../../resources');
}
