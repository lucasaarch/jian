import { create } from 'zustand';
import type { Subagent } from '../api';

export type GitHubItem = {
  kind: 'pull' | 'issue';
  owner: string;
  repo: string;
  number: number;
  url: string;
};
export type InspectorTab =
  | { key: string; kind: 'agent'; runId: string }
  | { key: string; kind: 'github'; item: GitHubItem }
  | { key: 'browser'; kind: 'browser' };
type Crew = {
  sessionId?: string;
  agents: Subagent[];
  following?: string;
  item?: GitHubItem;
  opener?: HTMLElement | null;
  tabs: InspectorTab[];
  /** The host's way to open its browser; absent where there is none. */
  openBrowser?: () => void;
  show: (sessionId: string, agents: Subagent[]) => void;
  follow: (runId: string, opener?: HTMLElement | null) => void;
  open: (item: GitHubItem, opener?: HTMLElement | null) => void;
  browser: () => void;
  keepBrowser: () => void;
  select: (key: string) => void;
  remove: (key: string) => void;
  close: () => void;
  leave: (sessionId: string) => void;
};
export const itemKey = (item: Pick<GitHubItem, 'owner' | 'repo' | 'number'>) =>
  `github:${item.owner}/${item.repo}#${item.number}`.toLowerCase();
const selected = (tab?: InspectorTab) => ({
  following: tab?.key,
  item: tab?.kind === 'github' ? tab.item : undefined,
});

/**
 * What each conversation had open, for when the owner comes back. Only these few words per
 * conversation: nothing of an Inspector is drawn or loaded while its conversation is not open.
 */
type Kept = Pick<Crew, 'tabs' | 'following' | 'item'>;
const kept = new Map<string, Kept>();
const KEPT_CONVERSATIONS = 50;
const keep = (sessionId: string | undefined, state: Kept) => {
  if (!sessionId) return;
  kept.delete(sessionId);
  if (state.tabs.length)
    kept.set(sessionId, { tabs: state.tabs, following: state.following, item: state.item });
  for (const oldest of kept.keys()) {
    if (kept.size <= KEPT_CONVERSATIONS) break;
    kept.delete(oldest);
  }
};
const EMPTY: Kept = { tabs: [], following: undefined, item: undefined };
const restored = (sessionId: string): Kept => kept.get(sessionId) ?? EMPTY;
export const useCrew = create<Crew>()((set, get) => ({
  agents: [],
  tabs: [],
  show: (sessionId, agents) => {
    const state = get();
    if (state.sessionId === sessionId) {
      set({ agents });
      return;
    }
    keep(state.sessionId, state);
    set({ sessionId, agents, opener: undefined, ...restored(sessionId) });
  },
  follow: (runId, opener) =>
    set((state) => ({
      following: runId,
      item: undefined,
      opener,
      tabs: state.tabs.some((tab) => tab.key === runId)
        ? state.tabs
        : [...state.tabs, { key: runId, kind: 'agent', runId }],
    })),
  open: (item, opener) =>
    set((state) => ({
      following: itemKey(item),
      item,
      opener,
      tabs: state.tabs.some((tab) => tab.key === itemKey(item))
        ? state.tabs
        : [...state.tabs, { key: itemKey(item), kind: 'github', item }],
    })),
  browser: () =>
    set((state) => ({
      following: 'browser',
      item: undefined,
      tabs: state.tabs.some((tab) => tab.key === 'browser')
        ? state.tabs
        : [...state.tabs, { key: 'browser', kind: 'browser' }],
    })),
  keepBrowser: () =>
    set((state) =>
      state.tabs.some((tab) => tab.key === 'browser')
        ? state
        : { tabs: [...state.tabs, { key: 'browser', kind: 'browser' }] },
    ),
  select: (key) => {
    const tab = get().tabs.find((tab) => tab.key === key);
    if (tab) set(selected(tab));
  },
  remove: (key) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.key === key);
      const tabs = state.tabs.filter((tab) => tab.key !== key);
      return {
        tabs,
        ...(state.following === key ? selected(tabs[Math.min(index, tabs.length - 1)]) : {}),
      };
    }),
  close: () => set({ following: undefined, item: undefined }),
  leave: (sessionId) => {
    const state = get();
    if (state.sessionId !== sessionId) return;
    keep(sessionId, state);
    set({ sessionId: undefined, agents: [], opener: undefined, ...EMPTY });
  },
}));
