import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** What is left to show of an agent just deleted. */
export type DepartedAgent = { name: string; avatar?: string | null; summary?: string };

type Onboarding = {
  completed: boolean;
  requested: boolean;
  /** A new agent is being made in the onboarding's own scene. Never kept. */
  creating: boolean;
  /** An agent just deleted, being seen off. Never kept. */
  departed?: DepartedAgent & { then: () => void };
  /** The onboarding is on screen now, so a host can put its own chrome away. Never kept. */
  showing: boolean;
  show: () => void;
  create: () => void;
  cancelCreating: () => void;
  /** `then` is what follows once it has gone: the app is out of the way by that time. */
  seeOff: (agent: DepartedAgent, then: () => void) => void;
  seenOff: () => void;
  finish: () => void;
  setShowing: (showing: boolean) => void;
};

/** The introduction belongs to this app/browser; its setup steps still come from the gateway. */
export const useOnboarding = create<Onboarding>()(
  persist(
    (set, get) => ({
      completed: false,
      requested: false,
      creating: false,
      showing: false,
      show: () => set({ requested: true }),
      create: () => set({ creating: true }),
      cancelCreating: () => set({ creating: false }),
      seeOff: (agent, then) => set({ departed: { ...agent, then } }),
      seenOff: () => {
        get().departed?.then();
        set({ departed: undefined });
      },
      finish: () => set({ completed: true, requested: false, creating: false }),
      setShowing: (showing) => set({ showing }),
    }),
    { name: 'jian-onboarding', partialize: ({ completed }) => ({ completed }) },
  ),
);

/** Whether the onboarding is on screen, for a host's own chrome to step aside. */
export const useStageShowing = () => useOnboarding((state) => state.showing);
