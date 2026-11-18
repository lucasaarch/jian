'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useState } from 'react';
import { mcpHealth } from '../../components/integrations/mcp-health';
import {
  Action,
  ConfirmDialog,
  SettingsGroup,
  SettingsRow,
  StatusPill,
  SwitchControl,
} from '../../kit';
import type { McpServer, McpStatus } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { useActions } from '../../lib/workspace';

type Check = { status?: McpStatus; error: string; busy: boolean };

/**
 * One check per account, asked as the page opens and again when the window comes back, since the
 * owner returns from the sign-in tab. A check can come back under another name: the gateway names
 * an app's new account after who signed in, and the list is read again to show it.
 */
export function useAccountChecks(names: string[]) {
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

type Checks = ReturnType<typeof useAccountChecks>;

/** How a connector's accounts stand together, in the word its details say. */
export function accountsStatus(accounts: McpServer[], checks: Checks): string {
  const tones = accounts.map(
    (server) => mcpHealth(checks.of(server.name), server.disabledTools ?? [])?.tone,
  );
  if (!accounts.length) return 'Not connected';
  if (tones.includes('warn')) return 'Needs sign-in';
  if (tones.includes('bad')) return 'Unreachable';
  return 'Connected';
}

/** What the first account that answers offers: every account of one service offers the same. */
export const toolsOf = (accounts: McpServer[], checks: Checks) =>
  accounts.map((server) => checks.of(server.name).status).find((status) => status?.reachable)
    ?.tools;

/**
 * The accounts of one of Jian's connectors that is an MCP server underneath, a card of them:
 * each by the name agents reach it by, with how it stands, its sign-in when it asks for one,
 * and its removal, which asks first since its sign-in or keys go with it.
 */
export function AccountList({
  service,
  accounts,
  checks,
  remove,
}: {
  /** What the accounts are of, as the question before a removal names it: \"Linear\". */
  service: string;
  accounts: McpServer[];
  checks: Checks;
  remove: (server: McpServer) => Promise<boolean>;
}) {
  return (
    <SettingsGroup title="Accounts">
      {accounts.map((server) => (
        <AccountRow
          key={server.name}
          service={service}
          server={server}
          check={checks.of(server.name)}
          remove={() => remove(server)}
        />
      ))}
    </SettingsGroup>
  );
}

function AccountRow({
  service,
  server,
  check,
  remove,
}: {
  service: string;
  server: McpServer;
  check: Check;
  remove: () => Promise<boolean>;
}) {
  const { busy } = useActions();
  const [asking, setAsking] = useState(false);
  const health = mcpHealth(check, server.disabledTools ?? []);
  const signIn = check.status?.authorizationUrl;

  return (
    <SettingsRow
      title={<span className="font-mono">{server.name}</span>}
      description={health?.tools ?? check.error}
    >
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
        Every agent stops reaching this {service} account on its next runs, and its sign-in or keys
        are deleted. You can connect it again.
      </ConfirmDialog>
    </SettingsRow>
  );
}

/**
 * What a connector gives the agents, a card of its tools as the server names and describes
 * them. With `onToggle`, each has the switch that offers it to every agent or to none; `off`
 * are the ones switched off.
 */
export function ToolList({
  tools,
  off = [],
  onToggle,
}: {
  tools: McpStatus['tools'];
  off?: string[];
  onToggle?: (tool: string) => void;
}) {
  const { busy } = useActions();
  const on = tools.filter((tool) => !off.includes(tool.name)).length;

  return (
    <SettingsGroup
      title="Tools"
      note={on < tools.length ? `${on} of ${tools.length} on` : `${tools.length}`}
    >
      {tools.map((tool) => (
        <SettingsRow
          key={tool.name}
          title={<span className="font-mono [overflow-wrap:anywhere]">{tool.name}</span>}
          // A server may describe a tool at length: the page keeps the start of it.
          description={tool.description && <span className="line-clamp-2">{tool.description}</span>}
        >
          {onToggle && (
            <SwitchControl
              label={`Offer ${tool.name}`}
              checked={!off.includes(tool.name)}
              disabled={busy}
              onCheckedChange={() => onToggle(tool.name)}
            />
          )}
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
