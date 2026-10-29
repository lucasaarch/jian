import { create } from 'zustand';
import type { Subagent } from '@/lib/api';

/**
 * The agents the open conversation handed work to, and the one the owner is following. The
 * history writes the list each time it reads the conversation; the drawer beside the
 * conversation, which sits outside the history, reads it from here.
 */
type Crew = {
  sessionId?: string;
  agents: Subagent[];
  /** The run followed in the drawer. */
  following?: string;
  /** What opened the drawer, so focus can go back to it. */
  opener?: HTMLElement | null;
  show: (sessionId: string, agents: Subagent[]) => void;
  follow: (runId: string, opener?: HTMLElement | null) => void;
  close: () => void;
  /** The conversation closed: its agents go with it. */
  leave: (sessionId: string) => void;
};

export const useCrew = create<Crew>()((set, get) => ({
  agents: [],
  show: (sessionId, agents) =>
    set(get().sessionId === sessionId ? { agents } : { sessionId, agents, following: undefined }),
  follow: (following, opener) => set({ following, opener }),
  close: () => set({ following: undefined }),
  leave: (sessionId) => {
    if (get().sessionId === sessionId)
      set({ sessionId: undefined, agents: [], following: undefined });
  },
}));
