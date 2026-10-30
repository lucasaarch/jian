import { app, type BrowserWindow, Notification, autoUpdater as squirrel } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateState } from '../../shared/updates';
import { fromSource, UpdateFlow, type Updater } from './flow';

/** Where a release is read in full; the repository electron-builder.yml publishes to. */
const RELEASE_PAGE = 'https://github.com/lucasaarch/jian/releases/tag/v';

/**
 * Resolves when Squirrel.Mac has accepted the downloaded release. electron-updater hands it the
 * zip and settles first; Squirrel checks the code signature only then, and its refusal would
 * otherwise arrive after the app already said the release was ready.
 */
function squirrelVerified(): { done: Promise<void>; stop: () => void } {
  let stop = () => {};
  const done = new Promise<void>((resolve, reject) => {
    const accepted = () => {
      stop();
      resolve();
    };
    const refused = (error: Error) => {
      stop();
      reject(error);
    };
    squirrel.on('update-downloaded', accepted);
    squirrel.on('error', refused);
    stop = () => {
      squirrel.off('update-downloaded', accepted);
      squirrel.off('error', refused);
    };
  });
  // Awaited only once the download settles; refused earlier, it must not count as unhandled.
  done.catch(() => {});
  return { done, stop };
}

/** electron-updater, against the GitHub releases electron-builder.yml names. */
function githubUpdater(): Updater {
  const { autoUpdater } = electronUpdater;
  // The flow decides when to download. What was downloaded installs on quit unless the owner
  // restarted for it sooner.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Failures reach the flow through the promises; an 'error' event with no listener would throw.
  autoUpdater.on('error', () => {});
  return {
    // An AppImage replaces its own file; a .deb belongs to the system's package manager.
    inPlace: process.platform !== 'linux' || Boolean(process.env.APPIMAGE),
    async check() {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable) return null;
      return { version: result.updateInfo.version, notes: result.updateInfo.releaseNotes };
    },
    async download(progress) {
      const listener = (info: {
        percent: number;
        transferred: number;
        total: number;
        bytesPerSecond: number;
      }) =>
        progress({
          percent: info.percent,
          transferred: info.transferred,
          total: info.total,
          bytesPerSecond: info.bytesPerSecond,
        });
      autoUpdater.on('download-progress', listener);
      const verified = process.platform === 'darwin' ? squirrelVerified() : undefined;
      try {
        await autoUpdater.downloadUpdate();
        await verified?.done;
      } finally {
        autoUpdater.off('download-progress', listener);
        verified?.stop();
      }
    },
    // Silent, and started again after: the owner asked for a restart, not an installer.
    install: () => autoUpdater.quitAndInstall(true, true),
  };
}

/**
 * The app's updates, wired to Electron: the flow, and a system notification when a release is
 * ready while the window is out of sight. The window's own status bar says so otherwise.
 */
export function appUpdates(deps: {
  window: () => BrowserWindow | undefined;
  /** Brings the window forward with the update sheet open. */
  show: () => void;
  changed: (state: UpdateState) => void;
  prepare: () => Promise<void>;
}): UpdateFlow {
  const version = app.getVersion();
  let announced: string | undefined;
  return new UpdateFlow({
    updater: fromSource(app.isPackaged, version) ? null : githubUpdater(),
    version,
    releaseUrl: (next) => `${RELEASE_PAGE}${next}`,
    changed: (state) => {
      deps.changed(state);
      if (state.status !== 'ready' || announced === state.release.version) return;
      announced = state.release.version;
      const window = deps.window();
      if ((window?.isVisible() && window.isFocused()) || !Notification.isSupported()) return;
      const notice = new Notification({
        title: `Jian ${state.release.version} is ready`,
        body: 'Restart to update now, or it installs the next time you quit.',
      });
      notice.on('click', deps.show);
      notice.show();
    },
    prepare: deps.prepare,
    recover: () => {
      app.relaunch();
      app.exit(0);
    },
  });
}
