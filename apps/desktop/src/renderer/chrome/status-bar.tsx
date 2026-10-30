import { UpdateBadge } from '@jian/ui';
import { Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { desktop } from '../desktop';

/**
 * The app's own bar under the conversations: the gateway in use, a chooser, and the app's
 * settings at the right end, as ⌘, opens them, after a quiet word when an update is waiting.
 */
export function StatusBar({
  gateway,
  openSettings,
}: {
  gateway: ReactNode;
  openSettings: () => void;
}) {
  const shortcut = desktop().platform === 'darwin' ? '⌘,' : 'Ctrl+,';
  return (
    <footer className="flex h-(--status-bar) shrink-0 items-center gap-1 border-t border-line bg-canvas px-2">
      {gateway}
      <div className="ml-auto flex items-center gap-1">
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
