import { Copy, Minus, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { desktop } from '../desktop';

const control =
  'grid h-(--title-bar) w-11 place-items-center text-muted hover:bg-accent-soft hover:text-ink';

/**
 * Minimize, maximize and close, drawn by the app on Windows and Linux, where it takes the
 * system's frame away. Close hides the window into the tray, as the system's button would.
 */
export function WindowControls({ className = '' }: { className?: string }) {
  const controls = desktop().windowControls;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => controls.onMaximized(setMaximized), [controls]);

  return (
    <div className={`flex ${className}`}>
      <button type="button" className={control} onClick={controls.minimize} aria-label="Minimize">
        <Minus size={15} />
      </button>
      <button
        type="button"
        className={control}
        onClick={controls.toggleMaximize}
        aria-label={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? <Copy size={13} className="-scale-x-100" /> : <Square size={13} />}
      </button>
      <button
        type="button"
        className={`${control} hover:bg-bad hover:text-on-accent`}
        onClick={controls.close}
        aria-label="Close"
      >
        <X size={16} />
      </button>
    </div>
  );
}
