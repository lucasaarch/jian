import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Drafts = {
  /** What was written and not sent, by `draftKey`; nothing is kept for an empty field. */
  texts: Record<string, string>;
  write: (key: string, text: string) => void;
  forgetAll: () => void;
};

/** A conversation's own, or the one new chat an agent is being written. */
export const draftKey = (profileId: string, sessionId?: string) =>
  `${profileId}:${sessionId ?? 'new'}`;

/**
 * What the owner was writing, kept in this browser so that going to another page, or closing the
 * window, loses nothing. Words only: a file attached stays with the composer that holds it.
 */
export const useDrafts = create<Drafts>()(
  persist(
    (set) => ({
      texts: {},
      write: (key, text) =>
        set((state) => {
          const { [key]: _was, ...rest } = state.texts;
          return { texts: text ? { ...rest, [key]: text } : rest };
        }),
      forgetAll: () => set({ texts: {} }),
    }),
    { name: 'jian-drafts', partialize: ({ texts }) => ({ texts }) },
  ),
);
