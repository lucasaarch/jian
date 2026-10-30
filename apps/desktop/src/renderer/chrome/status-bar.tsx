import { Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { desktop } from '../desktop';

/**
 * The app's own bar under the conversations: the gateway and the agent in use, each a chooser,
 * and the app's settings at the right end, as ⌘, opens them.
 */
export function StatusBar({
  gateway,
  agent,
  openSettings,
}: {
  gateway: ReactNode;
  agent?: ReactNode;
  openSettings: () => void;
}) {
  const shortcut = desktop().platform === 'darwin' ? '⌘,' : 'Ctrl+,';
  return (
    <footer className="glass-bar flex h-(--status-bar) shrink-0 items-center gap-1 border-t border-glass-edge px-2">
      {gateway}
      {agent && <span className="h-3.5 w-px bg-glass-edge" aria-hidden="true" />}
      {agent}
      <button
        type="button"
        onClick={openSettings}
        aria-label="Settings"
        title={`Settings (${shortcut})`}
        className="ml-auto grid size-7 place-items-center rounded-full text-muted transition-colors hover:bg-glass-hover hover:text-ink"
      >
        <Settings2 size={15} />
      </button>
    </footer>
  );
}
