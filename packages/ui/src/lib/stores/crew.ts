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
  | { key: string; kind: 'browser'; pageId: string; title: string; url: string };
export type BrowserPageTab = { id: string; title: string; url: string };
type Crew = {
  sessionId?: string;
  agents: Subagent[];
  /** Whether the Inspector is on screen, which it can be with nothing in it. */
  opened: boolean;
  /** Whether it has the chat's whole area. */
  full: boolean;
  /** The tab it shows: nothing while it is closed or empty. */
  following?: string;
  /** What it showed when it was closed, to come back to. */
  last?: string;
  item?: GitHubItem;
  opener?: HTMLElement | null;
  tabs: InspectorTab[];
  /** The host's way to open its browser; absent where there is none. */
  openBrowser?: () => void;
  show: (sessionId: string, agents: Subagent[]) => void;
  follow: (runId: string, opener?: HTMLElement | null) => void;
  open: (item: GitHubItem, opener?: HTMLElement | null) => void;
  /** Brings a browser tab to the front, the Inspector open around it. */
  browser: (pageId: string) => void;
  /** Takes the host's tabs as they stand: names, new ones and those no longer there. */
  syncBrowser: (pages: BrowserPageTab[]) => void;
  reopen: () => void;
  toggleFull: () => void;
  /** A new chat became this conversation, which takes over its Inspector as it stands. */
  adopt: (sessionId: string) => void;
  /** The host's way to hand its browser over with it. */
  adoptBrowser?: (sessionId: string) => void;
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
type Kept = Pick<Crew, 'tabs' | 'opened' | 'full' | 'following' | 'last' | 'item'>;
const SAVED = 'jian-inspector';
const KEPT_CONVERSATIONS = 50;
const isTab = (tab: unknown) =>
  Boolean(tab) &&
  typeof (tab as InspectorTab).key === 'string' &&
  ['agent', 'github', 'browser'].includes((tab as InspectorTab).kind);

/** Storage is the owner's but may hold an older shape: what does not read is left out. */
function readKept(): Map<string, Kept> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SAVED) ?? '{}');
    return new Map(
      Object.entries(saved as Record<string, Kept>).filter(
        ([, value]) => Array.isArray(value?.tabs) && value.tabs.every(isTab),
      ),
    );
  } catch {
    return new Map();
  }
}
let keptRead: Map<string, Kept> | undefined;
const kept = () => {
  keptRead ??= readKept();
  return keptRead;
};
let writing: ReturnType<typeof setTimeout> | undefined;
const write = () => {
  clearTimeout(writing);
  // Dragging tabs around writes once: a whole object for each change would be wasted.
  writing = setTimeout(() => {
    try {
      localStorage.setItem(SAVED, JSON.stringify(Object.fromEntries(kept())));
    } catch {
      // No storage: they are kept for this visit.
    }
  }, 300);
};
const keep = (sessionId: string | undefined, state: Kept) => {
  if (!sessionId) return;
  const all = kept();
  all.delete(sessionId);
  if (state.tabs.length)
    all.set(sessionId, {
      tabs: state.tabs,
      opened: state.opened,
      full: state.full,
      following: state.following,
      last: state.last,
      item: state.item,
    });
  for (const oldest of all.keys()) {
    if (all.size <= KEPT_CONVERSATIONS) break;
    all.delete(oldest);
  }
  write();
};
const EMPTY: Kept = {
  tabs: [],
  opened: false,
  full: false,
  following: undefined,
  last: undefined,
  item: undefined,
};
const restored = (sessionId: string): Kept => kept().get(sessionId) ?? EMPTY;
const browserTabKey = (pageId: string) => `browser:${pageId}`;
export const useCrew = create<Crew>()((set, get) => ({
  agents: [],
  tabs: [],
  opened: false,
  full: false,
  toggleFull: () => set((state) => ({ full: !state.full })),
  adopt: (sessionId) => {
    const state = get();
    if (state.sessionId) return;
    keep(sessionId, state);
    state.adoptBrowser?.(sessionId);
  },
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
      opened: true,
      following: runId,
      item: undefined,
      opener,
      tabs: state.tabs.some((tab) => tab.key === runId)
        ? state.tabs
        : [...state.tabs, { key: runId, kind: 'agent', runId }],
    })),
  open: (item, opener) =>
    set((state) => ({
      opened: true,
      following: itemKey(item),
      item,
      opener,
      tabs: state.tabs.some((tab) => tab.key === itemKey(item))
        ? state.tabs
        : [...state.tabs, { key: itemKey(item), kind: 'github', item }],
    })),
  browser: (pageId) =>
    set((state) => {
      const key = browserTabKey(pageId);
      return {
        opened: true,
        following: key,
        item: undefined,
        tabs: state.tabs.some((tab) => tab.key === key)
          ? state.tabs
          : [...state.tabs, { key, kind: 'browser', pageId, title: '', url: '' }],
      };
    }),
  syncBrowser: (pages) =>
    set((state) => {
      const known = new Map(pages.map((page) => [browserTabKey(page.id), page]));
      const remaining = state.tabs.flatMap((tab): InspectorTab[] => {
        if (tab.kind !== 'browser') return [tab];
        const page = known.get(tab.key);
        return page ? [{ ...tab, title: page.title, url: page.url }] : [];
      });
      const added = pages
        .filter((page) => !state.tabs.some((tab) => tab.key === browserTabKey(page.id)))
        .map(
          (page): InspectorTab => ({
            key: browserTabKey(page.id),
            kind: 'browser',
            pageId: page.id,
            title: page.title,
            url: page.url,
          }),
        );
      const tabs = [...remaining, ...added];
      const same =
        tabs.length === state.tabs.length &&
        tabs.every((tab, index) => {
          const was = state.tabs[index];
          return (
            was?.key === tab.key &&
            (tab.kind !== 'browser' ||
              (was.kind === 'browser' && was.title === tab.title && was.url === tab.url))
          );
        });
      if (same) return state;
      const gone = state.following && !tabs.some((tab) => tab.key === state.following);
      const at = state.tabs.findIndex((tab) => tab.key === state.following);
      return {
        tabs,
        ...(gone ? selected(tabs[Math.min(Math.max(at, 0), tabs.length - 1)]) : {}),
      };
    }),
  reopen: () =>
    set((state) => ({
      opened: true,
      ...selected(state.tabs.find((tab) => tab.key === state.last) ?? state.tabs.at(-1)),
    })),
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
  close: () =>
    set((state) => ({
      opened: false,
      last: state.following,
      following: undefined,
      item: undefined,
    })),
  leave: (sessionId) => {
    const state = get();
    if (state.sessionId !== sessionId) return;
    keep(sessionId, state);
    set({ sessionId: undefined, agents: [], opener: undefined, ...EMPTY });
  },
}));

// Whatever changes in the conversation on screen is what the owner returns to.
useCrew.subscribe((state, previous) => {
  if (!state.sessionId || state.sessionId !== previous.sessionId) return;
  if (
    state.tabs !== previous.tabs ||
    state.opened !== previous.opened ||
    state.full !== previous.full ||
    state.following !== previous.following
  )
    keep(state.sessionId, state);
});
