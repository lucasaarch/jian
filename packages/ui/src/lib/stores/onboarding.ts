import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type Onboarding = {
  completed: boolean;
  requested: boolean;
  show: () => void;
  finish: () => void;
};

/** The introduction belongs to this app/browser; its setup steps still come from the gateway. */
export const useOnboarding = create<Onboarding>()(
  persist(
    (set) => ({
      completed: false,
      requested: false,
      show: () => set({ requested: true }),
      finish: () => set({ completed: true, requested: false }),
    }),
    { name: 'jian-onboarding', partialize: ({ completed }) => ({ completed }) },
  ),
);
