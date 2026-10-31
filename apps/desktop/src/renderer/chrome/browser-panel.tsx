import {
  BrowserStart,
  BrowserToolbar,
  browserPageOfInspector,
  conversationOfInspector,
  InspectorHost,
  inspectorHasBrowserPage,
  onInspectorMoved,
  openBrowserInspector,
  syncBrowserInspector,
} from '@jian/ui';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserPlaces, BrowserState } from '../../shared/bridge';
import { desktop } from '../desktop';

const initial: BrowserState = {
  focus: 0,
  open: false,
  pages: [],
  favorite: false,
  url: '',
  title: '',
  loading: false,
  canBack: false,
  canForward: false,
};

const openNativeBrowser = () => desktop().browser.open();
const closeNativeBrowser = (pageId: string) => desktop().browser.close(pageId);
const adoptNativeBrowser = (sessionId: string) => desktop().browser.adopt(sessionId);

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
      const known = seen.current.get(key);
      // Tabs saved from before are the owner's choice as they left it, not a request to look.
      const fresh =
        known === undefined &&
        Boolean(state.activePageId) &&
        !inspectorHasBrowserPage(state.activePageId ?? '') &&
        state.focus > 0;
      syncBrowserInspector(state.pages);
      // Asked to look: a new tab, or an agent acting. Otherwise the owner's choice of tab stands.
      if (state.activePageId && (fresh || (known !== undefined && state.focus !== known)))
        openBrowserInspector(state.activePageId);
      seen.current.set(key, state.focus);
      const chosen = browserPageOfInspector();
      if (chosen && chosen !== state.activePageId) desktop().browser.select(chosen);
    };
    const read = () => void desktop().browser.state().then(follow);
    read();
    const stopFollowing = desktop().browser.onChanged(follow);
    const stopWatching = onInspectorMoved(read);
    // Comes back as the key it was, so the commands and the owner's bindings decide what it does.
    const stopShortcuts = desktop().browser.onShortcut(({ key, code, shift, alt }) => {
      const mac = desktop().platform === 'darwin';
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          code,
          shiftKey: shift,
          altKey: alt,
          metaKey: mac,
          ctrlKey: !mac,
        }),
      );
    });
    return () => {
      stopFollowing();
      stopWatching();
      stopShortcuts();
    };
  }, []);
  return (
    <InspectorHost
      browser={<BrowserPanel hidden={hidden} />}
      wholePanel
      openBrowser={openNativeBrowser}
      closeBrowser={closeNativeBrowser}
      adoptBrowser={adoptNativeBrowser}
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
  const [places, setPlaces] = useState<BrowserPlaces>({ favorites: [], recents: [] });
  const covered = useRef(false);
  const blank = !state.url || state.url === 'about:blank';
  const readPlaces = useCallback(() => void desktop().browser.places().then(setPlaces), []);
  // A blank tab reads them when it is shown; what changes them below reads them again.
  useEffect(() => {
    if (blank) readPlaces();
  }, [blank, readPlaces]);
  const navigate = (address: string) => {
    setError('');
    void desktop()
      .browser.navigate(address)
      .catch((failure) =>
        setError(failure instanceof Error ? failure.message : 'The page could not be opened'),
      );
  };
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
        // A tab's id changes with the conversation too, so a page moved in is always placed.
        width: state.activePageId && state.url && state.url !== 'about:blank' ? rect.width : 0,
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
  }, [state.open, state.url, state.activePageId, hidden]);
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Jian Browser">
      <BrowserToolbar
        url={state.url === 'about:blank' ? '' : state.url}
        enabled={state.open}
        canBack={state.canBack}
        canForward={state.canForward}
        loading={state.loading}
        favorite={state.favorite}
        onNavigate={navigate}
        onCommand={(command) => desktop().browser.command(command)}
        onFavorite={(on) => void desktop().browser.setFavorite(on, state.url, state.title)}
        onScreenshot={() => desktop().browser.screenshot()}
        onClear={(what) => desktop().browser.clear(what).then(readPlaces)}
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
        {blank && (
          <BrowserStart
            key={state.activePageId}
            places={places}
            onNavigate={navigate}
            onFavorite={(on, place) =>
              void desktop().browser.setFavorite(on, place.url, place.title).then(readPlaces)
            }
            onForget={(url) => void desktop().browser.forget(url).then(readPlaces)}
          />
        )}
      </div>
    </section>
  );
}
