import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Onboarding = {
  completed: boolean;
  requested: boolean;
  /** The Welcome is on screen now, so a host can put its own chrome away. Never kept. */
  showing: boolean;
  show: () => void;
  finish: () => void;
  setShowing: (showing: boolean) => void;
};

/** The introduction belongs to this app/browser; its setup steps still come from the gateway. */
export const useOnboarding = create<Onboarding>()(
  persist(
    (set) => ({
      completed: false,
      requested: false,
      showing: false,
      show: () => set({ requested: true }),
      finish: () => set({ completed: true, requested: false }),
      setShowing: (showing) => set({ showing }),
    }),
    { name: 'jian-onboarding', partialize: ({ completed }) => ({ completed }) },
  ),
);

/** Whether the Welcome is on screen, for a host's own chrome to step aside. */
export const useWelcomeShowing = () => useOnboarding((state) => state.showing);
