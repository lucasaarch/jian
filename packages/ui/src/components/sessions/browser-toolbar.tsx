'use client';

import { Menu } from '@base-ui/react/menu';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Cookie,
  Copy,
  Database,
  Ellipsis,
  ExternalLink,
  Globe,
  History,
  RefreshCcw,
  RotateCw,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Action, MenuDivider, MenuEntry, menuPopup, Overlay, RowInput } from '../../kit';

type CookieSource = { id: string; name: string };

const icon =
  'grid size-8 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-glass-hover hover:text-ink disabled:pointer-events-none disabled:opacity-45';

/** Bringing logins in is the owner's decision, and what the agents can then do is said first. */
function ImportCookies({
  source,
  host,
  run,
  close,
}: {
  source: CookieSource | undefined;
  host: string | undefined;
  run: (scope: 'site' | 'all') => Promise<void>;
  close: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const go = (scope: 'site' | 'all') => {
    setBusy(true);
    void run(scope).finally(() => {
      setBusy(false);
      close();
    });
  };
  return (
    <Overlay
      open={Boolean(source)}
      onOpenChange={(open) => !open && !busy && close()}
      title={`Import cookies from ${source?.name ?? 'a browser'}`}
      size="form"
    >
      <div className="grid gap-5 p-7">
        <header className="grid gap-1.5 pr-6">
          <h2 className="text-lg font-semibold tracking-tight">
            Import cookies from {source?.name}
          </h2>
          <p className="text-sm leading-relaxed text-muted">
            This copies your logins into this agent's browser. It stays signed in as you, and an
            agent using this browser can act on those sites in your name. macOS may ask you to allow
            access first.
          </p>
        </header>
        <div className="flex flex-wrap justify-end gap-2">
          <Action tone="quiet" onClick={close} disabled={busy}>
            Cancel
          </Action>
          <Action tone="outline" onClick={() => go('all')} disabled={busy}>
            All sites
          </Action>
          {host && (
            <Action tone="primary" onClick={() => go('site')} busy={busy}>
              Only {host}
            </Action>
          )}
        </div>
      </div>
    </Overlay>
  );
}

/** Back, forward, reload, the address and the rest behind a menu, all at the address's height. */
export function BrowserToolbar({
  url,
  enabled,
  canBack,
  canForward,
  loading,
  favorite,
  onNavigate,
  onCommand,
  onFavorite,
  onScreenshot,
  onClear,
  onOpenExternal,
  cookieSources,
  onImportCookies,
}: {
  url: string;
  enabled: boolean;
  canBack: boolean;
  canForward: boolean;
  loading: boolean;
  favorite: boolean;
  onNavigate: (address: string) => void;
  onCommand: (command: 'back' | 'forward' | 'reload' | 'hard-reload' | 'stop') => void;
  onFavorite: (on: boolean) => void;
  onScreenshot: () => Promise<boolean>;
  onClear: (what: 'history' | 'cookies' | 'cache') => Promise<void>;
  onOpenExternal: () => void;
  cookieSources: () => Promise<CookieSource[]>;
  onImportCookies: (
    source: string,
    scope: 'site' | 'all',
  ) => Promise<{ imported: number; skipped: number }>;
}) {
  const [address, setAddress] = useState(url);
  const [sources, setSources] = useState<CookieSource[]>([]);
  const [importing, setImporting] = useState<CookieSource>();
  const label = useId();
  const [clearingCookies, setClearingCookies] = useState(false);
  useEffect(() => setAddress(url), [url]);
  const clear = async (what: 'history' | 'cookies' | 'cache', done: string) => {
    try {
      await onClear(what);
      toast.success(done);
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : 'That could not be cleared');
    }
  };
  const host = (() => {
    try {
      return url ? new URL(url).hostname : undefined;
    } catch {
      return undefined;
    }
  })();
  return (
    <form
      className="flex shrink-0 items-center gap-2 border-b border-glass-edge pt-1 pr-1 pb-3 pl-3"
      onSubmit={(event) => {
        event.preventDefault();
        onNavigate(address);
      }}
    >
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className={icon}
          aria-label="Browser back"
          disabled={!canBack}
          onClick={() => onCommand('back')}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          type="button"
          className={icon}
          aria-label="Browser forward"
          disabled={!canForward}
          onClick={() => onCommand('forward')}
        >
          <ArrowRight size={15} />
        </button>
        <button
          type="button"
          className={icon}
          aria-label={loading ? 'Stop loading page' : 'Reload page'}
          onClick={() => onCommand(loading ? 'stop' : 'reload')}
        >
          {loading ? <X size={15} /> : <RotateCw size={15} />}
        </button>
      </div>
      <label id={label} htmlFor={`${label}-address`} className="sr-only">
        Browser address
      </label>
      <RowInput
        id={`${label}-address`}
        disabled={!enabled}
        labelledBy={label}
        className="min-w-0 flex-1 rounded-full"
        value={address}
        placeholder="Search or enter URL"
        onChange={(event) => setAddress(event.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        type="button"
        className={icon}
        aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
        aria-pressed={favorite}
        disabled={!url}
        onClick={() => onFavorite(!favorite)}
      >
        <Star size={15} className={favorite ? 'fill-current text-ink' : ''} />
      </button>
      <Menu.Root
        onOpenChange={(open) => {
          if (open) void cookieSources().then(setSources);
        }}
      >
        <Menu.Trigger aria-label="Browser options" className={icon}>
          <Ellipsis size={15} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
            <Menu.Popup className={`${menuPopup} min-w-56`}>
              <MenuEntry
                icon={<Camera size={14} />}
                disabled={!url}
                onClick={() =>
                  void onScreenshot().then((taken) =>
                    taken
                      ? toast.success('Screenshot copied to the clipboard')
                      : toast.error('The page could not be captured'),
                  )
                }
              >
                Take screenshot
              </MenuEntry>
              <MenuDivider />
              <MenuEntry
                icon={<RefreshCcw size={14} />}
                disabled={!url}
                onClick={() => onCommand('hard-reload')}
              >
                Hard reload
              </MenuEntry>
              <MenuEntry
                icon={<Copy size={14} />}
                disabled={!url}
                onClick={() => void navigator.clipboard.writeText(url)}
              >
                Copy current URL
              </MenuEntry>
              <MenuEntry icon={<ExternalLink size={14} />} disabled={!url} onClick={onOpenExternal}>
                Open in default browser
              </MenuEntry>
              <MenuDivider />
              <MenuEntry
                icon={<History size={14} />}
                onClick={() => void clear('history', 'Browsing history cleared')}
              >
                Clear browsing history
              </MenuEntry>
              <MenuEntry icon={<Trash2 size={14} />} onClick={() => setClearingCookies(true)}>
                Clear cookies
              </MenuEntry>
              <MenuEntry
                icon={<Database size={14} />}
                onClick={() => void clear('cache', 'Cache cleared')}
              >
                Clear cache
              </MenuEntry>
              {sources.length > 0 && <MenuDivider />}
              {sources.map((source) => (
                <MenuEntry
                  key={source.id}
                  icon={<Cookie size={14} />}
                  onClick={() => setImporting(source)}
                >
                  Import cookies from {source.name}
                </MenuEntry>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Overlay
        open={clearingCookies}
        onOpenChange={setClearingCookies}
        title="Clear cookies"
        size="form"
      >
        <div className="grid gap-5 p-7">
          <header className="grid gap-1.5 pr-6">
            <h2 className="text-lg font-semibold tracking-tight">Clear cookies</h2>
            <p className="text-sm leading-relaxed text-muted">
              This signs this agent's browser out of every site, in all its conversations.
            </p>
          </header>
          <div className="flex justify-end gap-2">
            <Action tone="quiet" onClick={() => setClearingCookies(false)}>
              Cancel
            </Action>
            <Action
              tone="danger"
              onClick={() => {
                setClearingCookies(false);
                void clear('cookies', 'Cookies cleared');
              }}
            >
              Clear cookies
            </Action>
          </div>
        </div>
      </Overlay>
      <ImportCookies
        source={importing}
        host={host}
        close={() => setImporting(undefined)}
        run={async (scope) => {
          if (!importing) return;
          try {
            const { imported, skipped } = await onImportCookies(importing.id, scope);
            toast.success(
              `Imported ${imported} cookies from ${importing.name}${skipped ? `; ${skipped} refused` : ''}`,
            );
          } catch (failure) {
            toast.error(failure instanceof Error ? failure.message : 'The import failed');
          }
        }}
      />
    </form>
  );
}

type Place = { url: string; title: string };
const hostOf = (url: string) => {
  try {
    return new URL(url).host + new URL(url).pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
};

/** A page to go back to: its name, where it is, and on hover the way to keep or drop it. */
function PlaceRow({
  place,
  favorite,
  onOpen,
  onFavorite,
  onForget,
}: {
  place: Place;
  favorite: boolean;
  onOpen: () => void;
  onFavorite: () => void;
  onForget?: () => void;
}) {
  return (
    <li className="group relative flex items-center rounded-lg transition-colors hover:bg-glass-hover">
      <button
        type="button"
        onClick={onOpen}
        className="flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-lg pr-16 pl-2.5 text-left text-[13px]"
      >
        <Globe size={14} className="shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 shrink-0 max-w-[55%] truncate text-ink">
          {place.title || hostOf(place.url)}
        </span>
        <span className="min-w-0 truncate text-xs text-muted">{hostOf(place.url)}</span>
      </button>
      <span className="absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          aria-label={
            favorite ? `Remove ${place.title} from favorites` : `Add ${place.title} to favorites`
          }
          className="grid size-6 place-items-center rounded-full text-muted transition-colors hover:text-ink"
          onClick={onFavorite}
        >
          <Star size={13} className={favorite ? 'fill-current text-ink' : ''} />
        </button>
        {onForget && (
          <button
            type="button"
            aria-label={`Remove ${place.title} from recents`}
            className="grid size-6 place-items-center rounded-full text-muted transition-colors hover:text-ink"
            onClick={onForget}
          >
            <X size={13} />
          </button>
        )}
      </span>
    </li>
  );
}

/** A new tab: where to go, and the pages the owner keeps coming back to. */
export function BrowserStart({
  places,
  onNavigate,
  onFavorite,
  onForget,
}: {
  places: { favorites: Place[]; recents: Place[] };
  onNavigate: (address: string) => void;
  onFavorite: (on: boolean, place: Place) => void;
  onForget: (url: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const field = useRef<HTMLInputElement>(null);
  // A new tab is for typing where to go.
  useEffect(() => field.current?.focus(), []);
  const section = 'px-2.5 pb-1 text-xs text-muted';
  return (
    <div className="absolute inset-0 overflow-y-auto px-8 pt-16 pb-10">
      <div className="mx-auto grid w-full max-w-md gap-6">
        <form
          className="relative"
          onSubmit={(event) => {
            event.preventDefault();
            if (typed.trim()) onNavigate(typed);
          }}
        >
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted"
          />
          <input
            ref={field}
            aria-label="Search or enter a website"
            placeholder="Search or enter URL"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="h-10 w-full rounded-full border border-glass-edge bg-glass-hover pr-4 pl-9 text-[13px] text-ink outline-none transition-colors placeholder:text-muted focus:border-ink/25"
          />
        </form>
        {places.favorites.length > 0 && (
          <section aria-label="Favorites">
            <h3 className={section}>Favorites</h3>
            <ul className="grid gap-0.5">
              {places.favorites.map((place) => (
                <PlaceRow
                  key={place.url}
                  place={place}
                  favorite
                  onOpen={() => onNavigate(place.url)}
                  onFavorite={() => onFavorite(false, place)}
                />
              ))}
            </ul>
          </section>
        )}
        {places.recents.length > 0 && (
          <section aria-label="Recents">
            <h3 className={section}>Recents</h3>
            <ul className="grid gap-0.5">
              {places.recents.map((place) => (
                <PlaceRow
                  key={place.url}
                  place={place}
                  favorite={false}
                  onOpen={() => onNavigate(place.url)}
                  onFavorite={() => onFavorite(true, place)}
                  onForget={() => onForget(place.url)}
                />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
