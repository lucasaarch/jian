'use client';

import { create } from 'zustand';

/**
 * Whether the chat search is open. The sidebar's own button opens it, and so does whatever the
 * host binds to it — a shortcut, a command — from outside the sidebar.
 */
export const useChatSearch = create<{ open: boolean; setOpen: (open: boolean) => void }>()(
  (set) => ({ open: false, setOpen: (open) => set({ open }) }),
);
