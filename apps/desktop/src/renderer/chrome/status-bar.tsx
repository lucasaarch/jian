import { UpdateBadge } from '@jian/ui';
import { Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { desktop } from '../desktop';

/** Where the gateway in use draws its own words into the bar: beside it, and at the right. */
export type StatusSlots = { start: HTMLElement | null; end: HTMLElement | null };

/**
 * The app's own bar under the conversations: the gateway in use, a chooser, then what is under
 * way — the agent at work, this computer in use — and at the right the subscriptions' windows,
 * a quiet word when an update is waiting, and the app's settings, as ⌘, opens them. What the
 * gateway in use tells is drawn by its panel into the bar's slots, where its data can be read.
 */
export function StatusBar({
  gateway,
  computer,
  slots,
  openSettings,
}: {
  gateway: ReactNode;
  computer: ReactNode;
  slots: {
    start: (element: HTMLElement | null) => void;
    end: (element: HTMLElement | null) => void;
  };
  openSettings: () => void;
}) {
  const shortcut = desktop().platform === 'darwin' ? '⌘,' : 'Ctrl+,';
  return (
    <footer className="flex h-(--status-bar) shrink-0 items-center gap-1 border-t border-line bg-canvas px-2">
      {gateway}
      <div ref={slots.start} className="flex min-w-0 items-center gap-1" />
      {computer}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <div ref={slots.end} className="flex items-center gap-1" />
        <UpdateBadge />
        <button
          type="button"
          onClick={openSettings}
          aria-label="Settings"
          title={`Settings (${shortcut})`}
          className="grid size-7 place-items-center rounded-full text-muted transition-colors hover:bg-glass-hover hover:text-ink"
        >
          <Settings2 size={15} />
        </button>
      </div>
    </footer>
  );
}
