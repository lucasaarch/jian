import type { DownloadProgress, UpdateRelease, UpdateState } from '../../shared/updates';
import { releaseLine } from '../gateways/rules';
import { failureOf } from './failure';
import { readNotes } from './notes';

/** A release newer than this one, as the updater found it. */
export type FoundRelease = { version: string; notes?: Parameters<typeof readNotes>[0] };

/** What the flow needs of electron-updater; the tests hand it a fake. */
export interface Updater {
  /** Whether this install can replace itself. A Linux package cannot: its package manager owns it. */
  readonly inPlace: boolean;
  /** The newer release, or null when this one is the latest. */
  check(): Promise<FoundRelease | null>;
  /** Settles once the release is downloaded and verified, ready to install. */
  download(progress: (progress: DownloadProgress) => void): Promise<void>;
  /** Quits and starts the new release. */
  install(): void;
}

/** How often a running app looks, in ms. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/**
 * How soon it looks again after GitHub could not be reached, or had no update files yet, in ms:
 * both pass on their own, and six hours is long to stay behind for either.
 */
export const RETRY_MS = 30 * 60 * 1000;

/** The version a build from source or a local package carries: it has no release to compare with. */
const DEVELOPMENT = '0.0.0-dev';

/** Whether this build has no releases to follow: run from source, or packaged by hand from it. */
export function fromSource(packaged: boolean, version: string): boolean {
  return !packaged || version === DEVELOPMENT;
}

/** States where a check would only start over what is already under way or done. */
const BUSY = new Set<UpdateState['status']>(['checking', 'available', 'downloading', 'ready']);

/**
 * The app's own updates, as a state machine: idle → checking → latest, or → available →
 * downloading → ready → install, any step able to end in failed. A build from source has no
 * updater and stays unavailable. Nothing here interrupts the owner: a release downloads in the
 * background and installs on quit, or when the owner restarts for it.
 */
export class UpdateFlow {
  private current: UpdateState;
  private checking: Promise<UpdateState> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private installing = false;

  constructor(
    private readonly deps: {
      updater: Updater | null;
      /** This app's release. */
      version: string;
      releaseUrl: (version: string) => string;
      changed: (state: UpdateState) => void;
      /**
       * Stops what must stop cleanly before the app quits into the installer, which on Windows
       * ends a process that takes more than a second or two.
       */
      prepare: () => Promise<void>;
      /** Starts the app again when the installer could not be started after `prepare`. */
      recover: () => void;
    },
  ) {
    const { version } = deps;
    this.current = deps.updater ? { status: 'idle', version } : { status: 'unavailable', version };
  }

  state(): UpdateState {
    return this.current;
  }

  /** Checks now and keeps checking, every few hours and sooner after a passing failure. */
  start(): void {
    if (!this.deps.updater || this.started) return;
    this.started = true;
    void this.check();
  }

  stop(): void {
    this.started = false;
    clearTimeout(this.timer);
  }

  /** Answers once the check has: a download it starts goes on in the background. */
  check(): Promise<UpdateState> {
    const { updater } = this.deps;
    if (!updater || BUSY.has(this.current.status)) {
      return this.checking ?? Promise.resolve(this.current);
    }
    this.checking = this.look(updater).finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  async install(): Promise<void> {
    const { updater } = this.deps;
    if (!updater || this.current.status !== 'ready' || this.installing) return;
    this.installing = true;
    await this.deps.prepare();
    try {
      updater.install();
    } catch (error) {
      // What prepare stopped stays stopped: starting over is the one clean way back.
      this.set({ status: 'failed', version: this.deps.version, ...failureOf(error) });
      this.deps.recover();
    }
  }

  private async look(updater: Updater): Promise<UpdateState> {
    const { version } = this.deps;
    this.set({ status: 'checking', version });
    let found: FoundRelease | null;
    try {
      found = await updater.check();
    } catch (error) {
      return this.set({ status: 'failed', version, ...failureOf(error) });
    }
    if (!found) return this.set({ status: 'latest', version, checkedAt: Date.now() });
    const release = this.describe(found);
    if (!updater.inPlace) return this.set({ status: 'manual', version, release });
    const answer = this.set({ status: 'available', version, release });
    void this.fetch(updater, release);
    return answer;
  }

  private async fetch(updater: Updater, release: UpdateRelease): Promise<void> {
    const { version } = this.deps;
    try {
      await updater.download((progress) => {
        // A progress event that arrives after the download settled must not take it back.
        if (this.current.status === 'available' || this.current.status === 'downloading') {
          this.set({ status: 'downloading', version, release, progress });
        }
      });
      this.set({ status: 'ready', version, release });
    } catch (error) {
      this.set({ status: 'failed', version, ...failureOf(error), release });
    }
  }

  private describe(found: FoundRelease): UpdateRelease {
    return {
      version: found.version,
      ...readNotes(found.notes),
      url: this.deps.releaseUrl(found.version),
      newLine: releaseLine(found.version) !== releaseLine(this.deps.version),
    };
  }

  private set(state: UpdateState): UpdateState {
    this.current = state;
    this.deps.changed(state);
    if (this.started) this.plan(state);
    return state;
  }

  /** When to look next, from where a check left things; a download in hand needs no more. */
  private plan(state: UpdateState): void {
    clearTimeout(this.timer);
    let wait: number | undefined;
    if (state.status === 'failed') {
      wait = state.failure === 'offline' || state.failure === 'missing' ? RETRY_MS : CHECK_EVERY_MS;
    } else if (state.status === 'latest' || state.status === 'manual') {
      wait = CHECK_EVERY_MS;
    }
    if (wait === undefined) return;
    this.timer = setTimeout(() => void this.check(), wait);
    this.timer.unref?.();
  }
}
