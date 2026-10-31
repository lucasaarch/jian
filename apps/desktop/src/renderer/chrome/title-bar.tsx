import { SidebarBar, useInspectorShowing, useWelcomeShowing, WindowControls } from '@jian/ui';
import { Globe } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import type { GatewaySummary } from '../../shared/bridge';
import { desktop } from '../desktop';
import { navigationFor } from '../gateways/navigation';

const drag = '[-webkit-app-region:drag]';

const idle = () => () => {};

/**
 * The app's own title bar, in place of the system's, drawn over the top of the window rather than
 * above it: the sidebar and whatever is open beside it run up to the window's edge. The window
 * moves by that whole top strip. Its left end is the chat sidebar's top — put it away, search,
 * back and forward. On macOS the traffic lights sit at its left; elsewhere the window's own
 * buttons float at the right, over what is open there.
 */
export function TitleBar({ gateway }: { gateway?: GatewaySummary }) {
  const mac = desktop().platform === 'darwin';
  const welcoming = useWelcomeShowing();
  const inspecting = useInspectorShowing();
  const memory = gateway ? navigationFor(gateway.id) : undefined;
  // Read to follow the navigation, so back and forward come alive as it moves.
  useSyncExternalStore(memory?.subscribe ?? idle, memory?.current ?? (() => ''));
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

  const shortcuts = mac
    ? { sidebar: '⌘B', search: '⌘K', back: '⌘[', forward: '⌘]' }
    : { sidebar: 'Ctrl+B', search: 'Ctrl+K', back: 'Alt+←', forward: 'Alt+→' };

  return (
    <>
      {/* Behind everything, so it is only a place to hold the window by: what is drawn over it
          and can be pressed is left out of the drag by the app's styles. */}
      <div aria-hidden="true" className={`${drag} absolute inset-x-0 top-0 h-(--title-bar)`} />
      {/* Nothing to put away, search or go back to while the Welcome is up: only the window's own. */}
      {!welcoming && (
        <header className="absolute top-0 left-0 z-30 flex h-(--title-bar) select-none">
          <SidebarBar
            // Room for the traffic lights, which macOS draws over this end of the bar.
            leading={<div className={mac ? 'w-19 shrink-0' : 'w-1.5 shrink-0'} />}
            shortcuts={shortcuts}
            {...(memory
              ? {
                  history: {
                    back: () => memory.back(),
                    forward: () => memory.forward(),
                    canBack,
                    canForward,
                  },
                }
              : {})}
          />
        </header>
      )}
      {!welcoming && !inspecting && (
        <button
          type="button"
          aria-label="Open Jian Browser"
          title="Open Jian Browser"
          onClick={() => desktop().browser.open()}
          className="absolute top-0 right-(--window-controls) z-30 grid h-(--title-bar) w-10 place-items-center text-muted hover:text-ink [-webkit-app-region:no-drag]"
        >
          <Globe size={15} />
        </button>
      )}
      {!mac && (
        <WindowControls
          actions={desktop().windowControls}
          className="absolute top-0 right-0 z-30"
        />
      )}
    </>
  );
}
