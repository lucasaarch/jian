import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Reading = {
  /** Long lines of code fold under themselves: in the file viewer and in every diff. */
  wrap: boolean;
  /** The same for a Markdown file read as its source: prose is written in long lines. */
  wrapProse: boolean;
  /** A changed file opens with its change laid into it, wherever it can be compared. */
  diff: boolean;
  setWrap: (wrap: boolean) => void;
  setWrapProse: (wrapProse: boolean) => void;
  setDiff: (diff: boolean) => void;
};

/**
 * How the owner likes code read, kept per browser and app so the next file, diff or visit opens
 * the same way. A reader's habit, not something the gateway needs to know.
 */
export const useReading = create<Reading>()(
  persist(
    (set) => ({
      wrap: false,
      wrapProse: true,
      diff: false,
      setWrap: (wrap) => set({ wrap }),
      setWrapProse: (wrapProse) => set({ wrapProse }),
      setDiff: (diff) => set({ diff }),
    }),
    {
      name: 'jian:reading',
      partialize: ({ wrap, wrapProse, diff }) => ({ wrap, wrapProse, diff }),
    },
  ),
);
