'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useEffectEvent, useState } from 'react';
import { mcpHealth } from '../../components/integrations/mcp-health';
import { useMcpServers } from '../../components/integrations/mcp-list';
import {
  Action,
  ConfirmDialog,
  Overlay,
  OverlayActions,
  SettingsCard,
  StatusPill,
} from '../../kit';
import type { McpServer, McpStatus } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { useActions } from '../../lib/workspace';
import { freeName, type McpApp, serversOf } from './mcp-apps';

/** The app's mark in the text colour, as GitHub's and X's are. */
function AppIcon({ app, size = 14 }: { app: McpApp; size?: number }) {
  return (
    <svg
      viewBox={app.icon.viewBox ?? '0 0 24 24'}
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={app.icon.path} />
    </svg>
  );
}

type Check = { status?: McpStatus; error: string; busy: boolean };

/**
 * One check per account, asked as the card opens and again when the window comes back, since the
 * owner returns from the sign-in tab. The card and its Configure share them: one server is never
 * asked twice for one look. A check can come back under another name: the gateway names an app's
 * new account after who signed in, and the list is read again to show it.
 */
function useAccountChecks(names: string[]) {
  const { api } = useActions();
  const client = useQueryClient();
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const check = async (name: string) => {
    setChecks((known) => ({ ...known, [name]: { ...known[name], error: '', busy: true } }));
    try {
      const status = await api.checkMcpServer(name);
      setChecks((known) => ({ ...known, [status.name]: { status, error: '', busy: false } }));
      if (status.name !== name) void client.invalidateQueries({ queryKey: keys.mcpServers });
    } catch (failure) {
      const error = failure instanceof Error ? failure.message : 'The check could not run.';
      setChecks((known) => ({ ...known, [name]: { error, busy: false } }));
    }
  };
  const key = names.join(' ');
  const all = useEffectEvent(() => {
    for (const name of names) void check(name);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again only when the accounts change.
  useEffect(() => {
    all();
    window.addEventListener('focus', all);
    return () => window.removeEventListener('focus', all);
  }, [key]);

  return {
    of: (name: string): Check => checks[name] ?? { error: '', busy: false },
    check,
  };
}

/**
 * One app of the catalog, as a card. Connect saves the service's own MCP server and opens its
 * sign-in; once one account is in, Configure holds every account, their sign-ins, and the way to
 * add another. The card is all there is of them: the MCP servers page leaves them out.
 */
export function McpAppCard({ app }: { app: McpApp }) {
  const { mutate, api } = useActions();
  const { servers, save, remove } = useMcpServers({ api, mutate });
  const accounts = serversOf(app, servers);
  const checks = useAccountChecks(accounts.map((server) => server.name));
  const [open, setOpen] = useState(false);

  const connect = (name: string) =>
    save(
      {
        name,
        transport: 'http',
        url: app.url,
        auth: 'oauth',
        headers: [],
        args: [],
        env: [],
        disabledTools: [],
      },
      'new',
    );

  const healths = accounts.map((server) =>
    mcpHealth(checks.of(server.name), server.disabledTools ?? []),
  );
  const signIn = healths.some((health) => health?.tone === 'warn');
  const failing = healths.some((health) => health?.tone === 'bad');

  return (
    <>
      <SettingsCard
        icon={<AppIcon app={app} />}
        title={app.name}
        status={
          accounts.length > 0 && (
            <span role="status" className="flex flex-wrap gap-1.5">
              <StatusPill tone="good">
                {accounts.length > 1 ? `${accounts.length} accounts` : 'Connected'}
              </StatusPill>
              {signIn && <StatusPill tone="warn">Needs sign-in</StatusPill>}
              {failing && <StatusPill tone="bad">Unreachable</StatusPill>}
            </span>
          )
        }
        description={app.description}
        action={
          accounts.length > 0 ? (
            <Action
              tone="outline"
              size="small"
              aria-label={`Configure ${app.name}`}
              onClick={() => setOpen(true)}
            >
              Configure
            </Action>
          ) : (
            <Action
              tone="outline"
              size="small"
              aria-label={`Connect ${app.name}`}
              onClick={() =>
                void connect(
                  freeName(
                    app,
                    servers.map((item) => item.name),
                  ),
                )
              }
            >
              Connect
            </Action>
          )
        }
      />
      <Overlay open={open} onOpenChange={setOpen} title={app.name} size="form">
        <AppSettings
          app={app}
          accounts={accounts}
          taken={servers.map((item) => item.name)}
          checks={checks}
          connect={connect}
          remove={(server) => remove(servers.indexOf(server))}
          close={() => setOpen(false)}
        />
      </Overlay>
    </>
  );
}

function AppSettings({
  app,
  accounts,
  taken,
  checks,
  connect,
  remove,
  close,
}: {
  app: McpApp;
  accounts: McpServer[];
  taken: string[];
  checks: ReturnType<typeof useAccountChecks>;
  connect: (name: string) => Promise<boolean>;
  remove: (server: McpServer) => Promise<boolean>;
  close: () => void;
}) {
  const { busy } = useActions();

  return (
    <div className="grid w-full grid-cols-1 gap-5 p-7">
      <header className="grid gap-1.5 pr-10">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <AppIcon app={app} size={16} />
          {app.name}
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          {app.description} Every agent reaches each account below, by its name.
        </p>
      </header>
      {accounts.length > 0 && (
        <ul className="divide-y divide-glass-edge rounded-xl border border-glass-edge bg-glass-hover">
          {accounts.map((server) => (
            <AccountRow
              key={server.name}
              app={app}
              server={server}
              check={checks.of(server.name)}
              remove={() => remove(server)}
            />
          ))}
        </ul>
      )}
      <p className="rounded-lg bg-ink/5 px-3 py-2.5 text-xs leading-relaxed text-muted">
        Each account is named after who signs in, once {app.name} says who that is. It signs in
        whichever account your browser is logged into: to connect another one, switch account there
        first, or open the sign-in in a private window.
      </p>
      <OverlayActions>
        <Action tone="outline" busy={busy} onClick={() => void connect(freeName(app, taken))}>
          <Plus size={14} />
          Connect another account
        </Action>
        <span className="flex-1" />
        <Action tone="quiet" onClick={close}>
          Close
        </Action>
      </OverlayActions>
    </div>
  );
}

function AccountRow({
  app,
  server,
  check,
  remove,
}: {
  app: McpApp;
  server: McpServer;
  check: Check;
  remove: () => Promise<boolean>;
}) {
  const { busy } = useActions();
  const [asking, setAsking] = useState(false);
  const health = mcpHealth(check, server.disabledTools ?? []);
  const signIn = check.status?.authorizationUrl;

  return (
    <li className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
      <span className="grid min-w-0 flex-1 basis-40">
        <span className="truncate font-mono text-[13px] text-ink">{server.name}</span>
        {health?.tools && <span className="text-xs text-muted">{health.tools}</span>}
      </span>
      {health && (
        <StatusPill tone={health.tone === 'neutral' ? 'quiet' : health.tone}>
          {health.label}
        </StatusPill>
      )}
      {signIn && (
        <Action
          tone="outline"
          size="small"
          aria-label={`Sign in ${server.name}`}
          onClick={() => window.open(signIn, '_blank', 'noopener,noreferrer')}
        >
          Sign in
        </Action>
      )}
      <Action
        tone="danger"
        size="small"
        aria-label={`Remove ${server.name}`}
        onClick={() => setAsking(true)}
      >
        Remove
      </Action>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Remove ${server.name}?`}
        action="Remove account"
        busy={busy}
        run={() => void remove().then((ok) => ok && setAsking(false))}
      >
        Every agent stops reaching this {app.name} account on its next runs, and its sign-in is
        deleted. You can connect it again.
      </ConfirmDialog>
    </li>
  );
}
