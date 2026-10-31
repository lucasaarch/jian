import {
  BrowserToolbar,
  closeBrowserInspector,
  conversationOfInspector,
  InspectorHost,
  keepBrowserInspector,
  onInspectorConversation,
  openBrowserInspector,
} from '@jian/ui';
import { Globe } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { BrowserState } from '../../shared/bridge';
import { desktop } from '../desktop';

const initial: BrowserState = {
  focus: 0,
  open: false,
  url: '',
  title: '',
  loading: false,
  canBack: false,
  canForward: false,
};

const openNativeBrowser = () => desktop().browser.open();
const closeNativeBrowser = () => desktop().browser.close();

/** One shared inspector: browser, PRs and subagents use the same glass, tabs and resize handle. */
export function BrowserInspector({
  children,
  hidden = false,
}: {
  children: ReactNode;
  hidden?: boolean;
}) {
  const seen = useRef(new Map<string, number>());
  useEffect(() => {
    const follow = (state: BrowserState) => {
      // The app and the main process change conversation in turn: what is about another waits.
      if (conversationOfInspector() !== state.sessionId) return;
      const key = state.sessionId ?? '';
      if (!state.open) closeBrowserInspector();
      else if (state.focus !== seen.current.get(key)) openBrowserInspector();
      else keepBrowserInspector();
      seen.current.set(key, state.focus);
    };
    const read = () => void desktop().browser.state().then(follow);
    read();
    const stopFollowing = desktop().browser.onChanged(follow);
    const stopWatching = onInspectorConversation(read);
    return () => {
      stopFollowing();
      stopWatching();
    };
  }, []);
  return (
    <InspectorHost
      browser={<BrowserPanel hidden={hidden} />}
      openBrowser={openNativeBrowser}
      closeBrowser={closeNativeBrowser}
    >
      {children}
    </InspectorHost>
  );
}

/** Anything drawn where the page is: the native view cannot be under it, so a picture stands in. */
const COVERS = '[role=dialog], [aria-modal=true], [role=menu], .reload-curtain';
const AWAY = { x: 0, y: 0, width: 0, height: 0 };

/** The browser's viewport and its bridge; the toolbar is the panel's, and the tabs the Inspector's. */
export function BrowserPanel({ hidden = false }: { hidden?: boolean }) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState('');
  const [picture, setPicture] = useState<string>();
  const covered = useRef(false);
  const shown = useRef('');
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void desktop().browser.state().then(setState);
    return desktop().browser.onChanged((state) => {
      setState(state);
      // A failure belongs to the address that failed; a new page starts clean.
      if (state.url !== shown.current) setError('');
      shown.current = state.url;
    });
  }, []);
  useEffect(
    () => () => {
      covered.current = false;
      desktop().browser.layout(AWAY);
    },
    [],
  );
  // Nothing here takes the page away on its way out: when `hidden` turns on, the page must still
  // be on screen for its picture to be taken.
  useEffect(() => {
    const element = viewport.current;
    if (!state.open || !element) {
      desktop().browser.layout(AWAY);
      return;
    }
    const cover = () => {
      if (covered.current) return;
      covered.current = true;
      void desktop()
        .browser.snapshot()
        .then((shot) => {
          // Uncovered while the picture was taken: the page never left.
          if (!covered.current) return;
          setPicture(shot ?? undefined);
          desktop().browser.layout(AWAY);
        });
    };
    const layout = () => {
      if (hidden || document.querySelector(COVERS)) return cover();
      covered.current = false;
      const rect = element.getBoundingClientRect();
      desktop().browser.layout({
        x: rect.x,
        y: rect.y,
        width: state.url && state.url !== 'about:blank' ? rect.width : 0,
        height: rect.height,
      });
      setPicture(undefined);
    };
    const covers = new MutationObserver(layout);
    covers.observe(document.body, { childList: true, subtree: true });
    const observer = new ResizeObserver(layout);
    observer.observe(element);
    window.addEventListener('resize', layout);
    layout();
    return () => {
      observer.disconnect();
      covers.disconnect();
      window.removeEventListener('resize', layout);
    };
  }, [state.open, state.url, hidden]);
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Jian Browser">
      <BrowserToolbar
        url={state.url === 'about:blank' ? '' : state.url}
        enabled={state.open}
        canBack={state.canBack}
        canForward={state.canForward}
        loading={state.loading}
        onNavigate={(address) => {
          setError('');
          void desktop()
            .browser.navigate(address)
            .catch((failure) =>
              setError(failure instanceof Error ? failure.message : 'The page could not be opened'),
            );
        }}
        onCommand={(command) => desktop().browser.command(command)}
        onOpenExternal={() => desktop().browser.openExternal()}
        cookieSources={() => desktop().browser.cookieSources()}
        onImportCookies={(source, scope) => desktop().browser.importCookies(source, scope)}
      />
      {(error || state.error) && (
        <p role="alert" className="border-b border-glass-edge px-4 py-3 text-xs text-bad">
          {error || state.error}
        </p>
      )}
      <div ref={viewport} className="relative min-h-0 flex-1">
        {picture && (
          <img src={picture} alt="" className="absolute inset-0 size-full object-cover" />
        )}
        {(!state.url || state.url === 'about:blank') && (
          <div className="grid h-full place-content-center justify-items-center gap-3 px-8 text-center text-muted">
            <Globe size={24} strokeWidth={1.2} />
            <p className="max-w-60 text-[13px] leading-relaxed">
              Open a website to explore it alongside your conversation.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
