/**
 * Where the app stands with its own releases, as the main process tells the window. The panel
 * draws the same shape from @jian/ui's `AppUpdate`; the window passes one for the other, so the
 * compiler holds the two together.
 */

/** A newer release, as the update window presents it. */
export type UpdateRelease = {
  version: string;
  /** The note's one-line summary, the first paragraph of the GitHub release. */
  summary: string;
  /** The rest of the note, Markdown, for whoever wants more than the summary. */
  notes: string;
  /** The release on GitHub, opened in the browser. */
  url: string;
  /**
   * It starts another major.minor. Every gateway the app connects to must run that line too; the
   * app's own gateway moves with it, servers do not.
   */
  newLine: boolean;
};

/** Why the last check or download failed, so the window can say what to do about it. */
export type UpdateFailure =
  /** GitHub could not be reached: no network, DNS, a proxy, a timeout. */
  | 'offline'
  /** The download did not match its checksum or its signature, and was thrown away. */
  | 'signature'
  /** The release has no update files for this system yet: it is still being published. */
  | 'missing'
  /** macOS cannot replace an app that runs from the disk image or a read-only place. */
  | 'read-only'
  | 'unknown';

export type DownloadProgress = {
  /** 0 to 100. */
  percent: number;
  /** Bytes so far and in all. */
  transferred: number;
  total: number;
  bytesPerSecond: number;
};

export type UpdateState =
  /** A build from source: it has no releases to compare with and never looks. */
  | { status: 'unavailable'; version: string }
  /** Packaged, and not asked yet. */
  | { status: 'idle'; version: string }
  | { status: 'checking'; version: string }
  /** `checkedAt` in ms since the epoch. */
  | { status: 'latest'; version: string; checkedAt: number }
  /** Found; the download is starting. */
  | { status: 'available'; version: string; release: UpdateRelease }
  | {
      status: 'downloading';
      version: string;
      release: UpdateRelease;
      progress: DownloadProgress;
    }
  /** Downloaded and verified: it installs on quit, or now on "Restart to update". */
  | { status: 'ready'; version: string; release: UpdateRelease }
  /**
   * Found, but this install cannot replace itself — a Linux package, which its package manager
   * owns — so the owner downloads the new one.
   */
  | { status: 'manual'; version: string; release: UpdateRelease }
  | {
      status: 'failed';
      version: string;
      failure: UpdateFailure;
      /** The updater's own words, first line only, for when the kind says too little. */
      detail: string;
      release?: UpdateRelease;
    };

export interface UpdatesBridge {
  state(): Promise<UpdateState>;
  /**
   * Looks now, unless a download is under way or done, and answers once the check has: the
   * download goes on in the background and is reported through `onChanged`.
   */
  check(): Promise<UpdateState>;
  /** Restarts into the downloaded release; does nothing unless one is ready. */
  install(): void;
  onChanged(listener: (state: UpdateState) => void): () => void;
  /** The main process asks for the update sheet: its notification of a ready release was clicked. */
  onShow(listener: () => void): () => void;
}
