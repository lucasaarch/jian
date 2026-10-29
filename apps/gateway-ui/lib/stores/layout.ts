'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

const SAVED = 'jian-layout';

type Panels = {
  /** The app's sidebar narrowed to its icons. */
  sidebar: boolean;
  /** The chat list out of the way, leaving the conversation the whole area. */
  chatList: boolean;
};

/**
 * Which panels this browser keeps collapsed, under `jian-layout`. A per-viewer convenience: it
 * renders expanded first and takes the saved choice once mounted, so the server and the first
 * client render agree, and storage that is off only means the choice lasts this visit.
 */
export const useLayout = create<
  Panels & { toggle: (panel: keyof Panels) => void; load: (saved: Panels) => void }
>()((set, get) => ({
  sidebar: false,
  chatList: false,
  toggle: (panel) => {
    set({ [panel]: !get()[panel] });
    const { sidebar, chatList } = get();
    try {
      window.localStorage.setItem(SAVED, JSON.stringify({ sidebar, chatList }));
    } catch {
      // No storage: the choice holds for this visit.
    }
  },
  load: (saved) => set(saved),
}));

/** Takes the saved choice once mounted. */
export function useSavedLayout() {
  const load = useLayout((state) => state.load);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(SAVED) ?? '{}') as Partial<Panels>;
      load({ sidebar: saved.sidebar === true, chatList: saved.chatList === true });
    } catch {
      // Nothing saved, or nothing readable: stay expanded.
    }
  }, [load]);
}
