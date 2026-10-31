'use client';

import { Menu } from '@base-ui/react/menu';
import {
  Bot,
  GitPullRequest,
  Globe,
  type LucideIcon,
  Maximize2,
  Minimize2,
  PanelRight,
  Plus,
  X,
} from 'lucide-react';
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
import { HoverTip, MenuEntry, menuPopup } from '../../kit';
import { githubItemOf } from '../../lib/github-links';
import { usePhone } from '../../lib/phone';
import { type BrowserPageTab, type InspectorTab, useCrew } from '../../lib/stores/crew';
import { MIN_CHAT_WIDTH, useLayout } from '../../lib/stores/layout';

/** An agent asked the panel to show something. Only the conversation it works in listens. */
export function focusInspector(
  sessionId: string,
  request: { sessionId?: string; kind?: string; url?: string; runId?: string } | null | undefined,
) {
  if (!request || request.sessionId !== sessionId) return;
  const crew = useCrew.getState();
  if (request.kind === 'subagent' && request.runId) return crew.follow(request.runId);
  if (request.kind === 'browser') {
    const tab = crew.tabs.find((candidate) => candidate.kind === 'browser');
    return tab?.kind === 'browser' ? crew.browser(tab.pageId) : crew.openBrowser?.();
  }
  const item = request.url ? githubItemOf(request.url) : undefined;
  if (item) crew.open(item);
}

const Portal = createContext<HTMLElement | null | undefined>(undefined);
export const openBrowserInspector = (pageId: string) => useCrew.getState().browser(pageId);
export const syncBrowserInspector = (pages: BrowserPageTab[]) =>
  useCrew.getState().syncBrowser(pages);
export const openInspector = () => useCrew.getState().reopen();
/** Open or closed, as a key does it. A host with nothing it could offer stays closed. */
export const toggleInspector = () => {
  const crew = useCrew.getState();
  if (crew.opened) crew.close();
  else if (crew.tabs.length || crew.openBrowser) crew.reopen();
};
export const conversationOfInspector = () => useCrew.getState().sessionId;
/** The browser tab the Inspector has in front, for a host to bring its page there. */
export const browserPageOfInspector = () => {
  const { tabs, following } = useCrew.getState();
  const tab = tabs.find((candidate) => candidate.key === following);
  return tab?.kind === 'browser' ? tab.pageId : undefined;
};
/** Tells when the Inspector moves to another conversation or another tab. */
export const onInspectorMoved = (listener: () => void) =>
  useCrew.subscribe((state, previous) => {
    if (state.sessionId !== previous.sessionId || state.following !== previous.following)
      listener();
  });
export const useInspectorShowing = () => useCrew((state) => state.opened);
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
const clamp = (width: number, available: number) =>
  Math.max(MIN_WIDTH, Math.min(width, Math.max(MIN_WIDTH, available)));
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

/** What the Inspector can open by itself, for its empty page and its plus button alike. */
type InspectorAction = { label: string; description: string; icon: LucideIcon; run: () => void };

/** The Inspector with nothing in it: what it is for, and what can be opened in it. */
function InspectorEmpty({ actions }: { actions: InspectorAction[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-8 pb-16">
      <div className="grid w-full max-w-sm gap-6">
        <header className="grid gap-1.5 text-center">
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Inspector</h2>
          <p className="text-[13px] leading-relaxed text-muted text-balance">
            Keep something open beside this conversation. Pull requests and subagents you follow
            land here too.
          </p>
        </header>
        <ul className="grid gap-2">
          {actions.map(({ label, description, icon: Icon, run }) => (
            <li key={label}>
              <button
                type="button"
                onClick={run}
                className="glass flex w-full items-center gap-3 rounded-2xl p-3 text-left transition-colors hover:bg-glass-hover"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-glass-press text-ink">
                  <Icon size={17} aria-hidden="true" />
                </span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="text-[13px] font-medium text-ink">{label}</span>
                  <span className="truncate text-xs text-muted">{description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function InspectorHost({
  children,
  browser,
  openBrowser,
  closeBrowser,
  wholePanel = false,
}: {
  children: ReactNode;
  /** Wraps the sidebar too, not only the conversation, so full screen must leave it in place. */
  wholePanel?: boolean;
  browser?: ReactNode;
  openBrowser?: () => void;
  /** Closes the page behind a browser tab. */
  closeBrowser?: (pageId: string) => void;
}) {
  const opened = useCrew((state) => state.opened);
  const following = useCrew((state) => state.following);
  const tabs = useCrew((state) => state.tabs);
  const agents = useCrew((state) => state.agents);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [chosen, setChosen] = useState(savedWidth);
  const [area, setArea] = useState(0);
  const [sidebar, setSidebar] = useState(0);
  const phone = usePhone();
  const fullChosen = useCrew((state) => state.full);
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
    const measure = () => {
      setArea(element.getBoundingClientRect().width);
      // The sidebar shares this area only where the host wraps the whole panel.
      const nav = element.querySelector('[data-chat-sidebar]');
      setSidebar(nav ? nav.getBoundingClientRect().width : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // The sidebar changes size without this element changing. Its new width is on the page only
    // after the store's change has been drawn.
    const stop = useLayout.subscribe(() => requestAnimationFrame(measure));
    return () => {
      observer.disconnect();
      stop();
    };
  }, []);
  // What is left for the Inspector once the sidebar and the chat's minimum are taken.
  const room = area - sidebar - MIN_CHAT_WIDTH;
  const width = clamp(chosen ?? defaultWidth(area - sidebar), room);
  // No room for both: the Inspector takes the chat's place rather than crush it.
  const full = !phone && (fullChosen || room < MIN_WIDTH);
  const resize = (next: number) => {
    const size = Math.round(clamp(next, room));
    setChosen(size);
    try {
      localStorage.setItem(WIDTH_KEY, String(size));
    } catch {}
  };
  const actions: InspectorAction[] = openBrowser
    ? [
        {
          label: 'Browser',
          description: 'Explore a website alongside your conversation',
          icon: Globe,
          run: openBrowser,
        },
      ]
    : [];
  const shown = tabs.find((tab) => tab.key === following);
  const label = (tab: InspectorTab) =>
    tab.kind === 'browser'
      ? tab.title || tab.url || 'New tab'
      : tab.kind === 'github'
        ? `${tab.item.kind === 'pull' ? 'PR' : 'Issue'} #${tab.item.number}`
        : (agents.find((agent) => agent.runId === tab.runId)?.name ?? 'Subagent');
  const close = () => useCrew.getState().close();
  const closeTab = (tab: InspectorTab) => {
    if (tab.kind === 'browser') closeBrowser?.(tab.pageId);
    useCrew.getState().remove(tab.key);
    // Where nothing can be opened, an empty Inspector would have nothing to offer.
    if (!actions.length && tabs.length === 1) close();
  };
  useEffect(() => {
    if (opened && !wasOpen.current) closer.current?.focus({ preventScroll: true });
    wasOpen.current = opened;
  }, [opened]);
  useEffect(() => {
    if (!opened) return;
    const keys = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('[role=dialog], [aria-modal=true]')
      )
        return;
      useCrew.getState().close();
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, [opened]);
  const finish = () => {
    drag.current = null;
  };
  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-1">
      <Portal.Provider value={target}>
        <div
          data-inspector-beside={full && opened ? 'full' : undefined}
          // Exactly the sidebar: the panel's own content has no width to go by once the chat is out.
          style={full && opened && wholePanel ? { width: sidebar } : undefined}
          className={`flex min-h-0 min-w-0 flex-col ${full && opened ? (wholePanel ? 'flex-none' : 'hidden') : 'flex-1'}`}
        >
          {children}
        </div>
        {opened && (
          <aside
            data-inspector-host
            data-full={full || undefined}
            aria-label="Inspector"
            className="inspector-host glass-bar relative flex min-h-0 shrink-0 flex-col border-l border-glass-edge"
            style={{ '--inspector-width': `${width}px` } as CSSProperties}
          >
            <hr
              aria-label="Resize inspector"
              aria-orientation="vertical"
              aria-valuenow={Math.round(width)}
              aria-valuemin={MIN_WIDTH}
              aria-valuemax={Math.max(MIN_WIDTH, room)}
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
            <div
              // Full screen with the sidebar put away reaches the title bar's own buttons.
              className={`relative z-40 flex h-10 shrink-0 items-center gap-1 pr-[calc(var(--window-controls,0px)+0.375rem)] ${full && wholePanel && !sidebar ? 'pl-52' : 'pl-3'} [-webkit-app-region:no-drag]`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <div
                  role="tablist"
                  aria-label="Inspector tabs"
                  className="flex min-w-0 items-center gap-1 overflow-x-auto"
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
                        title={tab.kind === 'browser' ? tab.title || tab.url : undefined}
                        onClick={() => useCrew.getState().select(tab.key)}
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
                        onClick={() => closeTab(tab)}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
                {actions.length > 0 && tabs.length > 0 && (
                  <Menu.Root>
                    <Menu.Trigger aria-label="Open in inspector" className={button}>
                      <Plus size={15} />
                    </Menu.Trigger>
                    <Menu.Portal>
                      <Menu.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
                        <Menu.Popup className={menuPopup}>
                          {actions.map(({ label: name, icon: Icon, run }) => (
                            <MenuEntry key={name} icon={<Icon size={14} />} onClick={run}>
                              {name}
                            </MenuEntry>
                          ))}
                        </Menu.Popup>
                      </Menu.Positioner>
                    </Menu.Portal>
                  </Menu.Root>
                )}
              </div>
              {!phone && (
                <HoverTip tip={full ? 'Exit full screen' : 'Full screen'}>
                  <button
                    type="button"
                    aria-label={full ? 'Exit full screen' : 'Full screen'}
                    aria-pressed={full}
                    // Without room for the chat there is nothing to go back to.
                    disabled={room < MIN_WIDTH}
                    className={`${button} disabled:pointer-events-none disabled:opacity-45`}
                    onClick={() => useCrew.getState().toggleFull()}
                  >
                    {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
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
                  <PanelRight size={15} />
                </button>
              </HoverTip>
            </div>
            <div
              role="tabpanel"
              id={`${id}-panel`}
              aria-labelledby={`${id}-${tabs.findIndex((tab) => tab.key === following)}`}
              className="flex min-h-0 flex-1 flex-col"
            >
              {shown?.kind === 'browser' ? (
                browser
              ) : shown ? (
                <div ref={setTarget} className="flex min-h-0 flex-1 flex-col" />
              ) : (
                <InspectorEmpty actions={actions} />
              )}
            </div>
          </aside>
        )}
      </Portal.Provider>
    </div>
  );
}
