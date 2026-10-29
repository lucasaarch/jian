import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type LastProfile = {
  /** The agent the owner had open, so `/` and an old link without one land back on it. */
  profileId: string | undefined;
  remember: (profileId: string) => void;
  forget: (profileId: string) => void;
};

/**
 * Kept in this browser only. It is a convenience, never a source of truth: a remembered agent
 * that no longer exists is ignored and the first one is opened instead.
 */
export const useLastProfile = create<LastProfile>()(
  persist(
    (set) => ({
      profileId: undefined,
      remember: (profileId) => set({ profileId }),
      forget: (profileId) =>
        set((state) => (state.profileId === profileId ? { profileId: undefined } : state)),
    }),
    { name: 'jian-last-agent', partialize: ({ profileId }) => ({ profileId }) },
  ),
);
