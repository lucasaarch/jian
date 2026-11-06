'use client';

import { useEffect, useEffectEvent, useState } from 'react';
import { useMcpCheck } from '../../components/integrations/mcp-check';
import { mcpHealth } from '../../components/integrations/mcp-health';
import { useMcpServers } from '../../components/integrations/mcp-list';
import { Action, ConfirmDialog, SettingsCard, StatusPill } from '../../kit';
import type { McpServer } from '../../lib/api';
import { useActions } from '../../lib/workspace';
import { freeName, type McpApp, serverOf } from './mcp-apps';

/** The app's mark in the text colour, as GitHub's and X's are. */
function AppIcon({ app }: { app: McpApp }) {
  return (
    <svg
      viewBox={app.icon.viewBox ?? '0 0 24 24'}
      width={14}
      height={14}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={app.icon.path} />
    </svg>
  );
}

/**
 * One app of the catalog, as a card. Connect saves the service's own MCP server, which opens its
 * sign-in. The card is all there is of it: the MCP servers page leaves it out.
 */
export function McpAppCard({ app }: { app: McpApp }) {
  const { api, mutate, busy } = useActions();
  const { servers, save, remove } = useMcpServers({ api, mutate });
  const server = serverOf(app, servers);

  if (server) {
    return (
      <SavedApp
        app={app}
        server={server}
        busy={busy}
        remove={() => remove(servers.indexOf(server))}
      />
    );
  }

  return (
    <SettingsCard
      icon={<AppIcon app={app} />}
      title={app.name}
      description={app.description}
      action={
        <Action
          tone="outline"
          size="small"
          aria-label={`Connect ${app.name}`}
          disabled={busy}
          onClick={() =>
            void save(
              {
                name: freeName(
                  app,
                  servers.map((item) => item.name),
                ),
                transport: 'http',
                url: app.url,
                auth: 'oauth',
                headers: [],
                args: [],
                env: [],
                disabledTools: [],
              },
              'new',
            )
          }
        >
          Connect
        </Action>
      }
    />
  );
}

/**
 * An app already saved: whether it answers, asked as the card opens and again when the window
 * comes back, since the owner returns from the sign-in tab; Sign in when it asks for one, and
 * Remove, which asks first.
 */
function SavedApp({
  app,
  server,
  busy,
  remove,
}: {
  app: McpApp;
  server: McpServer;
  busy: boolean;
  remove: () => Promise<boolean>;
}) {
  const { api } = useActions();
  const check = useMcpCheck(() => api.checkMcpServer(server.name));
  const ask = useEffectEvent(() => void check.check());
  useEffect(() => {
    ask();
    window.addEventListener('focus', ask);
    return () => window.removeEventListener('focus', ask);
  }, []);
  const health = mcpHealth(check, server.disabledTools ?? []);
  const signIn = check.status?.authorizationUrl;
  const [asking, setAsking] = useState(false);

  return (
    <>
      <SettingsCard
        icon={<AppIcon app={app} />}
        title={app.name}
        status={
          health && (
            <span role="status">
              <StatusPill tone={health.tone === 'neutral' ? 'quiet' : health.tone}>
                {health.label}
              </StatusPill>
            </span>
          )
        }
        description={app.description}
        action={
          <>
            {signIn && (
              <Action
                tone="outline"
                size="small"
                onClick={() => window.open(signIn, '_blank', 'noopener,noreferrer')}
              >
                Sign in
              </Action>
            )}
            <Action
              tone="outline"
              size="small"
              aria-label={`Remove ${app.name}`}
              onClick={() => setAsking(true)}
            >
              Remove
            </Action>
          </>
        }
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Remove ${app.name}?`}
        action="Remove app"
        busy={busy}
        run={() => void remove().then((ok) => ok && setAsking(false))}
      >
        Every agent stops reaching it on its next runs, and its sign-in is deleted. You can connect
        it again.
      </ConfirmDialog>
    </>
  );
}
