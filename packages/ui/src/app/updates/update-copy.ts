import { LOCALE } from '../../lib/format';
import type { AppUpdate, AppUpdateFailure } from './app-update';

/** What the sheet says above everything else, for each place an update can be. */
export function headline(update: AppUpdate | undefined): { title: string; body: string } {
  if (!update || update.status === 'idle' || update.status === 'checking') {
    return { title: 'Checking for updates…', body: 'Looking at Jian’s releases on GitHub.' };
  }
  switch (update.status) {
    case 'unavailable':
      return {
        title: 'Updates come with the installed app',
        body: 'This copy of Jian runs from source, so it has no releases to follow.',
      };
    case 'latest':
      return { title: 'Jian is up to date', body: `${update.version} is the latest release.` };
    case 'available':
    case 'downloading':
      return {
        title: `Jian ${update.release.version} is available`,
        body: 'It downloads in the background; keep working.',
      };
    case 'ready':
      return {
        title: `Jian ${update.release.version} is ready`,
        body: 'Restart to update now, or it installs the next time you quit.',
      };
    case 'manual':
      return {
        title: `Jian ${update.release.version} is available`,
        body: 'This install is a Linux package, which its package manager updates. Download the new package from the release.',
      };
    case 'failed':
      return failed[update.failure](update.release !== undefined);
  }
}

const failed: Record<AppUpdateFailure, (found: boolean) => { title: string; body: string }> = {
  offline: () => ({
    title: 'Couldn’t reach GitHub',
    body: 'Check your connection. Jian tries again on its own in a while.',
  }),
  signature: () => ({
    title: 'The update didn’t pass verification',
    body: 'Its signature or checksum didn’t match, so it was discarded and nothing was installed.',
  }),
  missing: () => ({
    title: 'This release is still being published',
    body: 'Its files for this system aren’t on GitHub yet. Jian tries again in a while.',
  }),
  'read-only': () => ({
    title: 'Move Jian to Applications to update',
    body: 'macOS can’t replace an app that runs from its disk image or Downloads. Move Jian to Applications, open it from there and try again.',
  }),
  unknown: (found) => ({
    title: found ? 'Couldn’t download the update' : 'Couldn’t check for updates',
    body: 'Try again in a moment.',
  }),
};

/** Bytes as a download reads them: one decimal under a hundred megabytes. */
export function size(bytes: number): string {
  const mb = bytes / 1_000_000;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/** What is left of a download at its current speed, roughly; nothing until there is a speed. */
export function remaining(progress: {
  transferred: number;
  total: number;
  bytesPerSecond: number;
}): string | undefined {
  if (progress.bytesPerSecond <= 0 || progress.total <= progress.transferred) return undefined;
  const seconds = (progress.total - progress.transferred) / progress.bytesPerSecond;
  if (seconds < 60) return `about ${Math.max(1, Math.round(seconds / 5) * 5)} s left`;
  return `about ${Math.round(seconds / 60)} min left`;
}

/** When the last check answered, as a clock reads it, or that it just did. */
export function checked(at: number, now = Date.now()): string {
  if (now - at < 60_000) return 'Checked just now';
  const time = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' }).format(at);
  return `Checked at ${time}`;
}
