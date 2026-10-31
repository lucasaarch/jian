'use client';

import { Bot, GitPullRequest, Globe, X } from 'lucide-react';
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { HoverTip } from '../../kit';
import { githubItemOf } from '../../lib/github-links';
import { type InspectorTab, useCrew } from '../../lib/stores/crew';

/** An agent asked the panel to show something. Only the conversation it works in listens. */
export function focusInspector(
  sessionId: string,
  request: { sessionId?: string; kind?: string; url?: string; runId?: string } | null | undefined,
) {
  if (!request || request.sessionId !== sessionId) return;
  const crew = useCrew.getState();
  if (request.kind === 'subagent' && request.runId) return crew.follow(request.runId);
  if (request.kind === 'browser') return crew.openBrowser?.();
  const item = request.url ? githubItemOf(request.url) : undefined;
  if (item) crew.open(item);
}

const Portal = createContext<HTMLElement | null | undefined>(undefined);
export const openBrowserInspector = () => useCrew.getState().browser();
export const closeBrowserInspector = () => useCrew.getState().remove('browser');
/** The tab back in its conversation, without taking focus from what the owner last had open. */
export const keepBrowserInspector = () => useCrew.getState().keepBrowser();
export const conversationOfInspector = () => useCrew.getState().sessionId;
/** Tells when the Inspector moves to another conversation, whose tabs it now holds. */
export const onInspectorConversation = (listener: () => void) =>
  useCrew.subscribe((state, previous) => {
    if (state.sessionId !== previous.sessionId) listener();
  });
export const useInspectorShowing = () => useCrew((state) => Boolean(state.following));
export const useInspectorHosted = () => useContext(Portal) !== undefined;

/** Existing drawers keep their query/focus context when a desktop host provides the shared panel. */
export function InspectorContent({ children }: { children: ReactNode }) {
  const target = useContext(Portal);
  return target === undefined ? children : target ? createPortal(children, target) : null;
}

/** The web hosts this beside its conversation; a desktop host can provide it around the whole panel. */
export function InspectorLayout({ children }: { children: ReactNode }) {
  const hosted = useInspectorHosted();
  return hosted ? children : <InspectorHost>{children}</InspectorHost>;
}

const WIDTH_KEY = 'jian:inspector-size';
const MIN_WIDTH = 300;
/** What the conversation keeps however wide the owner drags the inspector. */
const KEPT_WIDTH = 320;
const clamp = (width: number, available: number) =>
  Math.max(MIN_WIDTH, Math.min(width, Math.max(MIN_WIDTH, available - KEPT_WIDTH)));
/** Half the room, up to a size a page reads well at; a browser needs more than a side note does. */
const defaultWidth = (available: number) => Math.min(800, Math.round(available / 2));
/** The owner's own size. Only their resize writes it: a narrow window must not forget it. */
const savedWidth = () => {
  try {
    return Number(localStorage.getItem(WIDTH_KEY)) || null;
  } catch {
    return null;
  }
};
const button =
  'grid size-7 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-glass-hover hover:text-ink';

export function InspectorHost({
  children,
  browser,
  openBrowser,
  closeBrowser,
}: {
  children: ReactNode;
  browser?: ReactNode;
  openBrowser?: () => void;
  closeBrowser?: () => void;
}) {
  const following = useCrew((state) => state.following);
  const tabs = useCrew((state) => state.tabs);
  const agents = useCrew((state) => state.agents);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [chosen, setChosen] = useState(savedWidth);
  const [room, setRoom] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const closer = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const id = useId();
  useEffect(() => {
    useCrew.setState({ openBrowser });
    return () => useCrew.setState({ openBrowser: undefined });
  }, [openBrowser]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setRoom(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const width = clamp(chosen ?? defaultWidth(room), room);
  const resize = (next: number) => {
    const size = Math.round(clamp(next, room));
    setChosen(size);
    try {
      localStorage.setItem(WIDTH_KEY, String(size));
    } catch {}
  };
  const label = (tab: InspectorTab) =>
    tab.kind === 'browser'
      ? 'Browser'
      : tab.kind === 'github'
        ? `${tab.item.kind === 'pull' ? 'PR' : 'Issue'} #${tab.item.number}`
        : (agents.find((agent) => agent.runId === tab.runId)?.name ?? 'Subagent');
  const close = () => {
    if (following === 'browser') closeBrowser?.();
    useCrew.getState().close();
  };
  useEffect(() => {
    if (following && !wasOpen.current) closer.current?.focus({ preventScroll: true });
    wasOpen.current = Boolean(following);
  }, [following]);
  useEffect(() => {
    if (!following) return;
    const keys = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('[role=dialog], [aria-modal=true]')
      )
        return;
      if (following === 'browser') closeBrowser?.();
      useCrew.getState().close();
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, [following, closeBrowser]);
  const finish = () => {
    drag.current = null;
  };
  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-1">
      <Portal.Provider value={target}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        {following && (
          <aside
            data-inspector-host
            aria-label="Inspector"
            className="inspector-host glass-bar relative flex min-h-0 shrink-0 flex-col border-l border-glass-edge"
            style={{ '--inspector-width': `${width}px` } as CSSProperties}
          >
            <hr
              aria-label="Resize inspector"
              aria-orientation="vertical"
              aria-valuenow={Math.round(width)}
              aria-valuemin={MIN_WIDTH}
              aria-valuemax={Math.max(MIN_WIDTH, room - KEPT_WIDTH)}
              tabIndex={0}
              className="absolute inset-y-0 -left-2 z-40 m-0 h-full w-2 cursor-col-resize touch-none border-0 bg-transparent focus-visible:outline focus-visible:outline-1 focus-visible:outline-ink/20"
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  resize(width + (event.key === 'ArrowLeft' ? 32 : -32));
                }
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { x: event.clientX, width };
              }}
              onPointerMove={(event) => {
                if (drag.current) resize(drag.current.width + drag.current.x - event.clientX);
              }}
              onPointerUp={finish}
              onPointerCancel={finish}
              onLostPointerCapture={finish}
            />
            {/* The close button sits where the title bar's browser button was: 20px from the edge. */}
            <div className="relative z-40 flex h-10 shrink-0 items-center gap-1 pr-[calc(var(--window-controls,0px)+0.375rem)] pl-3 [-webkit-app-region:no-drag]">
              <div
                role="tablist"
                aria-label="Inspector tabs"
                className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
              >
                {tabs.map((tab, index) => (
                  <div
                    key={tab.key}
                    className="flex min-w-0 shrink-0 items-center rounded-lg transition-colors hover:bg-glass-hover data-[active=true]:bg-glass-press"
                    data-active={tab.key === following}
                  >
                    <button
                      type="button"
                      role="tab"
                      id={`${id}-${index}`}
                      aria-selected={tab.key === following}
                      aria-controls={`${id}-panel`}
                      tabIndex={tab.key === following ? 0 : -1}
                      className="flex h-7 min-w-0 max-w-44 items-center gap-1.5 rounded-lg pr-1 pl-2 text-xs text-muted transition-colors hover:text-ink aria-selected:text-ink"
                      onClick={() => {
                        if (tab.kind === 'browser') openBrowser?.();
                        useCrew.getState().select(tab.key);
                      }}
                      onKeyDown={(event) => {
                        const next =
                          event.key === 'ArrowRight'
                            ? (index + 1) % tabs.length
                            : event.key === 'ArrowLeft'
                              ? (index + tabs.length - 1) % tabs.length
                              : event.key === 'Home'
                                ? 0
                                : event.key === 'End'
                                  ? tabs.length - 1
                                  : -1;
                        if (next >= 0) {
                          event.preventDefault();
                          const selected = tabs[next];
                          if (selected) {
                            if (selected.kind === 'browser') openBrowser?.();
                            useCrew.getState().select(selected.key);
                            document.getElementById(`${id}-${next}`)?.focus();
                          }
                        }
                      }}
                    >
                      {tab.kind === 'browser' ? (
                        <Globe size={13} />
                      ) : tab.kind === 'github' ? (
                        <GitPullRequest size={13} />
                      ) : (
                        <Bot size={13} />
                      )}
                      <span className="truncate">{label(tab)}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${label(tab)} tab`}
                      className="mr-1 grid size-5 shrink-0 place-items-center rounded-full text-muted transition-colors hover:text-ink"
                      onClick={() => {
                        if (tab.kind === 'browser') closeBrowser?.();
                        useCrew.getState().remove(tab.key);
                      }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
              {openBrowser && !tabs.some((tab) => tab.kind === 'browser') && (
                <HoverTip tip="Open browser">
                  <button
                    type="button"
                    className={button}
                    aria-label="Open browser in inspector"
                    onClick={openBrowser}
                  >
                    <Globe size={14} />
                  </button>
                </HoverTip>
              )}
              <HoverTip tip="Close inspector">
                <button
                  type="button"
                  aria-label="Close inspector"
                  ref={closer}
                  className={button}
                  onClick={close}
                >
                  <X size={16} />
                </button>
              </HoverTip>
            </div>
            <div
              role="tabpanel"
              id={`${id}-panel`}
              aria-labelledby={`${id}-${tabs.findIndex((tab) => tab.key === following)}`}
              className="flex min-h-0 flex-1 flex-col"
            >
              {following === 'browser' ? (
                browser
              ) : (
                <div ref={setTarget} className="flex min-h-0 flex-1 flex-col" />
              )}
            </div>
          </aside>
        )}
      </Portal.Provider>
    </div>
  );
}
