import { create } from 'zustand';

/** A file by where it is read from: one of the conversation's roots, and its path in it. */
export type OpenFile = { root: string; path: string };

const SAVED = 'jian-files';
const KEPT_CONVERSATIONS = 50;
/** Folders remembered per conversation; past it the oldest go back to how they start. */
const KEPT_FOLDERS = 500;

type Files = {
  /**
   * The file each conversation shows in its chat's place. Kept for the visit only: a panel opened
   * again starts on the conversation, not on a file that may be gone.
   */
  open: Record<string, OpenFile>;
  /**
   * Per conversation, the folders that are not as they start (a root folded, a folder opened),
   * by the tree's id. Saved, so the tree is found as it was left.
   */
  toggled: Record<string, string[]>;
  view: (sessionId: string, file: OpenFile) => void;
  /** Back to the conversation. */
  back: (sessionId: string) => void;
  toggle: (sessionId: string, folderId: string) => void;
};

/** Storage is the owner's but may hold another shape: what does not read is left out. */
function saved(): Files['toggled'] {
  try {
    const read: unknown = JSON.parse(localStorage.getItem(SAVED) ?? '{}');
    return Object.fromEntries(
      Object.entries(read as Record<string, unknown>).filter(
        ([, folders]) =>
          Array.isArray(folders) && folders.every((folder) => typeof folder === 'string'),
      ),
    ) as Files['toggled'];
  } catch {
    return {};
  }
}

export const useFiles = create<Files>()((set) => ({
  open: {},
  toggled: saved(),
  view: (sessionId, file) => set((state) => ({ open: { ...state.open, [sessionId]: file } })),
  back: (sessionId) =>
    set((state) => {
      if (!state.open[sessionId]) return state;
      const { [sessionId]: _closed, ...open } = state.open;
      return { open };
    }),
  toggle: (sessionId, folderId) =>
    set((state) => {
      const { [sessionId]: was = [], ...others } = state.toggled;
      const now = was.includes(folderId)
        ? was.filter((id) => id !== folderId)
        : [...was, folderId].slice(-KEPT_FOLDERS);
      // Written last, so the conversations touched longest ago are the ones forgotten.
      const toggled = Object.fromEntries(
        [...Object.entries(others), ...(now.length ? [[sessionId, now] as const] : [])].slice(
          -KEPT_CONVERSATIONS,
        ),
      );
      try {
        localStorage.setItem(SAVED, JSON.stringify(toggled));
      } catch {
        // No storage: the tree is remembered for this visit.
      }
      return { toggled };
    }),
}));
