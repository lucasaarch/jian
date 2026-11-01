import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CodeDiff } from '../api';

/** How many reviewed files are remembered: the oldest give way, so this never grows for good. */
const MOST = 1_000;

type Reviewed = {
  /** What each reviewed file looked like when it was marked, by where it is shown and its path. */
  files: Record<string, string>;
  mark: (key: string, print: string) => void;
  unmark: (key: string) => void;
};

/**
 * Kept per browser and app, like a reader's place in a book: what the owner has looked at here,
 * not something the gateway or GitHub needs to know.
 */
export const useReviewed = create<Reviewed>()(
  persist(
    (set) => ({
      files: {},
      mark: (key, print) =>
        set(({ files }) => {
          // Taken out first, so a file marked again counts as the newest.
          const { [key]: _earlier, ...others } = files;
          const entries = Object.entries({ ...others, [key]: print });
          return { files: Object.fromEntries(entries.slice(-MOST)) };
        }),
      unmark: (key) =>
        set(({ files }) => {
          const { [key]: _gone, ...others } = files;
          return { files: others };
        }),
    }),
    { name: 'jian:reviewed-files' },
  ),
);

/** What a file's change says, in a few characters: enough to notice it is not what was reviewed. */
function printOf(diff: Pick<CodeDiff, 'hunks'>): string {
  const text = JSON.stringify(diff.hunks);
  let hash = 5381;
  for (let at = 0; at < text.length; at += 1) {
    hash = Math.trunc(hash * 33 + text.charCodeAt(at)) % 2_147_483_647;
  }

  return `${text.length}:${hash}`;
}

/**
 * Whether the owner marked this file as reviewed. A file that changed since is not reviewed any
 * more, whatever was marked: what they looked at is not what is there now. With no `scope`, the
 * place showing it offers no review.
 */
export function useFileReview(scope: string | undefined, diff: CodeDiff) {
  const key = `${scope}:${diff.path}`;
  const print = printOf(diff);
  const marked = useReviewed((state) => state.files[key]);

  return {
    reviewed: Boolean(scope) && marked === print,
    set: (reviewed: boolean) => {
      if (reviewed) useReviewed.getState().mark(key, print);
      else useReviewed.getState().unmark(key);
    },
  };
}
