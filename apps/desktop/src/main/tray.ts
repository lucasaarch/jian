import { join } from 'node:path';
import { app, Menu, type MenuItemConstructorOptions, nativeImage, Tray } from 'electron';

/**
 * The app's place while its window is closed. On macOS the icon is a template, which the menu
 * bar tints for light and dark. The menu is built anew on `update`: a built menu does not
 * follow what its items were made from.
 */
export function createTray(options: {
  menu: () => MenuItemConstructorOptions[];
  open: () => void;
}): { update(): void } {
  const name = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const tray = new Tray(nativeImage.createFromPath(join(resourcesDir(), name)));
  tray.setToolTip('Jian');
  const update = () => tray.setContextMenu(Menu.buildFromTemplate(options.menu()));
  update();
  // Windows and Linux open the window on a click; macOS shows the menu, as its menu bar does.
  if (process.platform !== 'darwin') tray.on('click', options.open);
  return { update };
}

/** The app's own images: beside the build in development, in the package's resources when packaged. */
export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(import.meta.dirname, '../../resources');
}
