'use client';

import { ChevronLeft, ChevronRight, PanelLeft, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { useChatSearch } from '../lib/stores/chat-search';
import { useLayout } from '../lib/stores/layout';
import { shortcutOf } from './commands/keybindings';
import { useKeymaps } from './commands/registry';

/** Going back and forward through the places the host's navigation has been. */
export type History = {
  back: () => void;
  forward: () => void;
  canBack: boolean;
  canForward: boolean;
};

/** The keys the host binds to each, as its system writes them, for the buttons' titles. */
export type SidebarShortcuts = Partial<Record<'sidebar' | 'search' | 'back' | 'forward', string>>;

// A window dragged by its title bar must still let these buttons be pressed.
export const barButton =
  'grid size-7 place-items-center rounded-md text-muted transition-colors [-webkit-app-region:no-drag] hover:bg-glass-hover hover:text-ink disabled:pointer-events-none disabled:opacity-35';

const titled = (label: string, keys?: string) => (keys ? `${label} (${keys})` : label);

/**
 * The top of the chat sidebar, which a host draws over the top of its window: put the sidebar
 * away, search the chats, go back and forward. It has no ground of its own: over the sidebar it
 * takes the sidebar's width, which keeps `--chrome-top` clear for it; with the sidebar away, its
 * buttons float over the conversation's corner. `leading` is room the host keeps first, such as
 * macOS's traffic lights.
 */
export function SidebarBar({
  leading,
  history,
  trailing,
  shortcuts = {},
}: {
  leading?: ReactNode;
  history?: History;
  /** What the host keeps at the bar's other end: the web's way into settings. */
  trailing?: ReactNode;
  shortcuts?: SidebarShortcuts;
}) {
  const keymaps = useKeymaps();
  const bound = keymaps
    ? {
        ...shortcuts,
        sidebar: shortcutOf(keymaps.commands.find((command) => command.id === 'sidebar')?.keys),
        search: shortcutOf(keymaps.commands.find((command) => command.id === 'search-chats')?.keys),
      }
    : shortcuts;
  const collapsed = useLayout((state) => state.chatList);
  const toggle = useLayout((state) => state.toggle);
  const search = useChatSearch((state) => state.setOpen);

  return (
    <div className="flex h-full shrink-0 items-center gap-0.5 pr-2 over-sidebar:w-(--sidebar-width) phone:w-full!">
      {leading}
      <button
        type="button"
        // A phone's sidebar is the screen itself; there is nothing to put it away beside.
        className={`${barButton} phone:hidden`}
        onClick={() => toggle('chatList')}
        aria-label={collapsed ? 'Show the sidebar' : 'Hide the sidebar'}
        aria-expanded={!collapsed}
        title={titled(collapsed ? 'Show the sidebar' : 'Hide the sidebar', bound.sidebar)}
      >
        <PanelLeft size={15} />
      </button>
      <button
        type="button"
        className={barButton}
        onClick={() => search(true)}
        aria-label="Search chats"
        title={titled('Search chats', bound.search)}
      >
        <Search size={15} />
      </button>
      {history && (
        <>
          <span className="min-w-2 flex-1" />
          <button
            type="button"
            className={barButton}
            onClick={history.back}
            disabled={!history.canBack}
            aria-label="Back"
            title={titled('Back', shortcuts.back)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className={barButton}
            onClick={history.forward}
            disabled={!history.canForward}
            aria-label="Forward"
            title={titled('Forward', shortcuts.forward)}
          >
            <ChevronRight size={16} />
          </button>
        </>
      )}
      {trailing && (
        <>
          {!history && <span className="min-w-2 flex-1" />}
          {trailing}
        </>
      )}
    </div>
  );
}

/** What the bar's buttons do, for a host's shortcuts and commands. */
export const toggleSidebar = () => useLayout.getState().toggle('chatList');
export const searchChats = () => useChatSearch.getState().setOpen(true);
