'use client';

import { create } from 'zustand';

/**
 * Where an installed app stands with its own releases, as its host reports it. The desktop app's
 * main process sends this very shape; a host without releases of its own never draws it.
 */
export type AppUpdateRelease = {
  version: string;
  /** The note's one-line summary. */
  summary: string;
  /** The rest of the note, Markdown. */
  notes: string;
  /** The release on GitHub. */
  url: string;
  /** It starts another major.minor, which every connected gateway must run too. */
  newLine: boolean;
};

export type AppUpdateFailure = 'offline' | 'signature' | 'missing' | 'read-only' | 'unknown';

export type AppUpdate =
  | { status: 'unavailable'; version: string }
  | { status: 'idle'; version: string }
  | { status: 'checking'; version: string }
  /** `checkedAt` in ms since the epoch. */
  | { status: 'latest'; version: string; checkedAt: number }
  | { status: 'available'; version: string; release: AppUpdateRelease }
  | {
      status: 'downloading';
      version: string;
      release: AppUpdateRelease;
      /** `percent` 0 to 100, sizes in bytes. */
      progress: { percent: number; transferred: number; total: number; bytesPerSecond: number };
    }
  | { status: 'ready'; version: string; release: AppUpdateRelease }
  /** Found, but this install updates through its package manager: the owner downloads it. */
  | { status: 'manual'; version: string; release: AppUpdateRelease }
  | {
      status: 'failed';
      version: string;
      failure: AppUpdateFailure;
      detail: string;
      release?: AppUpdateRelease;
    };

/** What a host does for its updates: the desktop app's main process, through its bridge. */
export type UpdatesHost = {
  state(): Promise<AppUpdate>;
  /** Looks now, unless a download is under way or done; answers once the check has. */
  check(): Promise<AppUpdate>;
  /** Restarts into the downloaded release. */
  install(): void;
  onChanged(listener: (update: AppUpdate) => void): () => void;
};

/** The update sheet, open or not, and the last state the host reported. */
export const useAppUpdate = create<{
  update?: AppUpdate;
  open: boolean;
  /** Set when the sheet was opened to check, until the host has been asked. */
  checkOnOpen: boolean;
  setUpdate: (update: AppUpdate) => void;
  show: (check: boolean) => void;
  setOpen: (open: boolean) => void;
}>()((set) => ({
  open: false,
  checkOnOpen: false,
  setUpdate: (update) => set({ update }),
  show: (check) => set({ open: true, checkOnOpen: check }),
  setOpen: (open) => set({ open, ...(open ? {} : { checkOnOpen: false }) }),
}));

/**
 * Opens the update sheet, from wherever the host offers it: the command palette and the
 * settings check now; the status bar's "Update ready" only shows what is there.
 */
export const openUpdates = (options: { check?: boolean } = {}) =>
  useAppUpdate.getState().show(options.check === true);
