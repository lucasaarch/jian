'use client';

import { useEffect } from 'react';
import { create } from 'zustand';

const SAVED = 'jian-layout';

type Panels = {
  /** The chat list out of the way, leaving the conversation the whole area. */
  chatList: boolean;
  /** The sidebar's sections folded to their heading, by section id. */
  closedSections: string[];
};

type Layout = Panels & {
  toggle: (panel: 'chatList') => void;
  toggleSection: (id: string) => void;
  load: (saved: Panels) => void;
};

function save({ chatList, closedSections }: Panels) {
  try {
    window.localStorage.setItem(SAVED, JSON.stringify({ chatList, closedSections }));
  } catch {
    // No storage: the choice holds for this visit.
  }
}

/**
 * Which panels this browser keeps collapsed, under `jian-layout`. A per-viewer convenience: it
 * renders expanded first and takes the saved choice once mounted, so the server and the first
 * client render agree, and storage that is off only means the choice lasts this visit.
 */
export const useLayout = create<Layout>()((set, get) => ({
  chatList: false,
  closedSections: [],
  toggle: (panel) => {
    set({ [panel]: !get()[panel] });
    save(get());
  },
  toggleSection: (id) => {
    const closed = get().closedSections;
    set({
      closedSections: closed.includes(id) ? closed.filter((item) => item !== id) : [...closed, id],
    });
    save(get());
  },
  load: (saved) => set(saved),
}));

/** Takes the saved choice once mounted. */
export function useSavedLayout() {
  const load = useLayout((state) => state.load);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(SAVED) ?? '{}') as Partial<Panels>;
      load({
        chatList: saved.chatList === true,
        closedSections: Array.isArray(saved.closedSections)
          ? saved.closedSections.filter((id): id is string => typeof id === 'string')
          : [],
      });
    } catch {
      // Nothing saved, or nothing readable: stay expanded.
    }
  }, [load]);
}
