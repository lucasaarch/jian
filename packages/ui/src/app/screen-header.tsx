'use client';

import type { ReactNode } from 'react';
import { useLayout } from '../lib/stores/layout';

/**
 * The bar of a screen in the chat's place that has tools to hold (pull requests), in the host's
 * title bar and as tall as it is. Its end keeps clear of the window's own buttons, which Windows
 * and Linux draw there; with no Inspector on such a screen, nothing else is. With the sidebar
 * away, its buttons float over the bar's start. A screen only read, as Activity, has none.
 */
export function ScreenHeader({ title, children }: { title: string; children: ReactNode }) {
  const collapsed = useLayout((state) => state.chatList);
  return (
    <header
      className={`flex h-(--chrome-top) shrink-0 items-center gap-1 border-b border-line pr-[calc(var(--window-controls,0px)+1.25rem)] ${collapsed ? 'pl-52' : 'pl-5'} phone:h-auto phone:py-2 phone:pr-3 phone:pl-3`}
    >
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink phone:invisible">
        {title}
      </h1>
      {children}
    </header>
  );
}
