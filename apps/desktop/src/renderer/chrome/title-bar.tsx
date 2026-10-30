import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import type { GatewaySummary } from '../../shared/bridge';
import { desktop } from '../desktop';
import { navigationFor } from '../gateways/navigation';
import { placeName } from './place';
import { WindowControls } from './window-controls';

const drag = '[-webkit-app-region:drag]';
const noDrag = '[-webkit-app-region:no-drag]';
const button = `${noDrag} grid size-7 place-items-center rounded-md text-muted hover:bg-accent-soft hover:text-ink disabled:pointer-events-none disabled:opacity-35`;

const idle = () => () => {};

/**
 * The app's own title bar, in place of the system's: the window moves by it, it says where the
 * panel is and in which gateway, and it goes back and forward through the panel's history. On
 * macOS the traffic lights sit at its left; elsewhere its right end holds the window's buttons.
 */
export function TitleBar({ gateway }: { gateway?: GatewaySummary }) {
  const mac = desktop().platform === 'darwin';
  const memory = gateway ? navigationFor(gateway.id) : undefined;
  const pathname = useSyncExternalStore(memory?.subscribe ?? idle, memory?.current ?? (() => ''));
  const canBack = memory?.canGoBack() ?? false;
  const canForward = memory?.canGoForward() ?? false;

  useEffect(() => {
    if (!memory) return;
    // The shortcuts each system's browsers use for the same.
    const keys = (event: KeyboardEvent) => {
      const back = mac
        ? event.metaKey && event.key === '['
        : event.altKey && event.key === 'ArrowLeft';
      const forward = mac
        ? event.metaKey && event.key === ']'
        : event.altKey && event.key === 'ArrowRight';
      if (!back && !forward) return;
      event.preventDefault();
      if (back) memory.back();
      else memory.forward();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [memory, mac]);

  return (
    <header
      className={`${drag} flex h-(--title-bar) shrink-0 select-none items-center gap-1 border-b border-line bg-canvas`}
    >
      {/* Room for the traffic lights, which macOS draws over this end of the bar. */}
      <div className={mac ? 'w-19 shrink-0' : 'w-1.5 shrink-0'} />
      <button
        type="button"
        className={button}
        onClick={() => memory?.back()}
        disabled={!canBack}
        aria-label="Back"
        title={mac ? 'Back (⌘[)' : 'Back (Alt+←)'}
      >
        <ChevronLeft size={16} />
      </button>
      <button
        type="button"
        className={button}
        onClick={() => memory?.forward()}
        disabled={!canForward}
        aria-label="Forward"
        title={mac ? 'Forward (⌘])' : 'Forward (Alt+→)'}
      >
        <ChevronRight size={16} />
      </button>
      <p className="min-w-0 flex-1 truncate px-2 text-center text-xs text-muted">
        {gateway ? (
          <>
            <span className="text-ink">{placeName(pathname)}</span>
            <span aria-hidden="true"> · </span>
            {gateway.name}
          </>
        ) : (
          'Jian'
        )}
      </p>
      {/* On macOS, as wide as the traffic lights with back and forward: the place sits centred. */}
      <div className={mac ? 'w-35 shrink-0' : 'shrink-0'}>
        {!mac && <WindowControls className={noDrag} />}
      </div>
    </header>
  );
}
