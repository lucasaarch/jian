'use client';

import { Menu } from '@base-ui/react/menu';
import {
  ArrowLeft,
  ArrowRight,
  Cookie,
  Copy,
  EllipsisVertical,
  ExternalLink,
  RotateCw,
  X,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
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
  onNavigate,
  onCommand,
  onOpenExternal,
  cookieSources,
  onImportCookies,
}: {
  url: string;
  enabled: boolean;
  canBack: boolean;
  canForward: boolean;
  loading: boolean;
  onNavigate: (address: string) => void;
  onCommand: (command: 'back' | 'forward' | 'reload' | 'stop') => void;
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
  useEffect(() => setAddress(url), [url]);
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
        placeholder="Enter a website address"
        onChange={(event) => setAddress(event.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <Menu.Root
        onOpenChange={(open) => {
          if (open) void cookieSources().then(setSources);
        }}
      >
        <Menu.Trigger aria-label="Browser options" className={icon}>
          <EllipsisVertical size={15} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
            <Menu.Popup className={`${menuPopup} min-w-56`}>
              <MenuEntry
                icon={<Copy size={14} />}
                onClick={() => void navigator.clipboard.writeText(url)}
              >
                Copy address
              </MenuEntry>
              <MenuEntry icon={<ExternalLink size={14} />} onClick={onOpenExternal}>
                Open in default browser
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
