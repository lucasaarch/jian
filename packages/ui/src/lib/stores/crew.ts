import { create } from 'zustand';
import type { Subagent } from '../api';

/** A pull request or an issue on GitHub, as a link names it. */
export type GitHubItem = {
  kind: 'pull' | 'issue';
  owner: string;
  repo: string;
  number: number;
  url: string;
};

/**
 * The agents the open conversation handed work to, and what the drawer beside it follows: one
 * of those agents or a GitHub item the conversation links to. The history writes the list each
 * time it reads the conversation; the drawer, which sits outside the history, reads it here.
 */
type Crew = {
  sessionId?: string;
  agents: Subagent[];
  /**
   * What the drawer follows: an agent's run id, or a GitHub item's `github:` key. One value for
   * both, so whatever watches the drawer open and close watches one field.
   */
  following?: string;
  /** The GitHub item followed, when `following` is one. */
  item?: GitHubItem;
  /** What opened the drawer, so focus can go back to it. */
  opener?: HTMLElement | null;
  show: (sessionId: string, agents: Subagent[]) => void;
  follow: (runId: string, opener?: HTMLElement | null) => void;
  open: (item: GitHubItem, opener?: HTMLElement | null) => void;
  close: () => void;
  /** The conversation closed: its agents go with it. */
  leave: (sessionId: string) => void;
};

export const itemKey = (item: Pick<GitHubItem, 'owner' | 'repo' | 'number'>) =>
  `github:${item.owner}/${item.repo}#${item.number}`.toLowerCase();

export const useCrew = create<Crew>()((set, get) => ({
  agents: [],
  show: (sessionId, agents) =>
    set(
      get().sessionId === sessionId
        ? { agents }
        : { sessionId, agents, following: undefined, item: undefined },
    ),
  follow: (following, opener) => set({ following, item: undefined, opener }),
  open: (item, opener) => set({ following: itemKey(item), item, opener }),
  close: () => set({ following: undefined, item: undefined }),
  leave: (sessionId) => {
    if (get().sessionId === sessionId)
      set({ sessionId: undefined, agents: [], following: undefined, item: undefined });
  },
}));
