'use client';

import { Copy, Minus, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { barButton } from './sidebar-bar';

/** What a host does for the window's buttons; on the desktop, calls across its context bridge. */
export type WindowActions = {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  onMaximized(listener: (maximized: boolean) => void): () => void;
};

/**
 * Minimize, maximize and close, drawn by the app on Windows and Linux, where it takes the
 * system's frame away, in the size and the hover of the bar's other buttons. Close hides the
 * window into the tray, as the system's button would.
 *
 * Each handler calls its action with nothing: handed to `onClick` directly, an action would get
 * the click's event, and a context bridge refuses to clone that, with the components it points
 * to ("An object could not be cloned"), so the call never leaves the page.
 */
export function WindowControls({
  actions,
  className = '',
}: {
  actions: WindowActions;
  className?: string;
}) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => actions.onMaximized(setMaximized), [actions]);

  return (
    <div className={`flex h-(--title-bar) items-center gap-0.5 pr-1.5 ${className}`}>
      <button
        type="button"
        className={barButton}
        onClick={() => actions.minimize()}
        aria-label="Minimize"
        title="Minimize"
      >
        <Minus size={15} />
      </button>
      <button
        type="button"
        className={barButton}
        onClick={() => actions.toggleMaximize()}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? <Copy size={13} className="-scale-x-100" /> : <Square size={13} />}
      </button>
      <button
        type="button"
        className={barButton}
        onClick={() => actions.close()}
        aria-label="Close"
        title="Close"
      >
        <X size={15} />
      </button>
    </div>
  );
}
