'use client';

import { Pencil, Plug, RefreshCw, Unplug } from 'lucide-react';
import { useState } from 'react';
import type { GatewayApi, McpServer, Profile } from '../../lib/api';
import { Badge, Button, ProviderLogo, ResourceRow, serviceOf } from '../ui';
import { McpResult, useMcpCheck } from './mcp-check';

const auths: Record<string, string> = {
  none: 'No sign-in',
  headers: 'Signs in with headers',
  oauth: 'Signs in with OAuth',
};

/**
 * One connected server. Opening it checks the connection, since what a server offers is the
 * first thing to know about it, and the answer lands in the badges as well as underneath.
 */
export function McpRow({
  server,
  profile,
  api,
  onEdit,
  onRemove,
  onToggleTool,
  saving,
}: {
  server: McpServer;
  profile: Profile;
  api: GatewayApi;
  onEdit: () => void;
  onRemove: () => void;
  onToggleTool: (tool: string) => void;
  saving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { status, error, busy, check } = useMcpCheck(profile, server.name, api);
  const address =
    server.transport === 'stdio'
      ? [server.command, ...server.args].filter(Boolean).join(' ')
      : (server.url ?? '');

  const off = server.disabledTools ?? [];
  const on = status?.reachable ? status.tools.filter((tool) => !off.includes(tool.name)).length : 0;
  return (
    <ResourceRow
      id={`mcp-${server.name}`}
      icon={<McpIcon server={server} />}
      name={server.name}
      badges={
        busy ? (
          <Badge>Checking…</Badge>
        ) : error ? (
          <Badge tone="bad">Check failed</Badge>
        ) : status?.reachable ? (
          <>
            <Badge tone="good">Connected</Badge>
            <Badge dot={false}>
              {on} {on === 1 ? 'tool' : 'tools'}
              {on < status.tools.length && ` of ${status.tools.length}`}
            </Badge>
          </>
        ) : status?.authorizationUrl ? (
          <Badge tone="warn">Needs sign-in</Badge>
        ) : status ? (
          <Badge tone="bad">Unreachable</Badge>
        ) : null
      }
      description={address}
      facts={[
        server.transport === 'stdio' ? 'A command on this machine' : 'Over HTTP',
        auths[server.auth] ?? server.auth,
      ]}
      action="Manage"
      open={open}
      onToggle={() => {
        if (!open && !status && !busy) void check();
        setOpen(!open);
      }}
    >
      <McpResult
        status={status}
        error={error}
        disabled={off}
        onToggle={onToggleTool}
        busy={saving}
      />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" busy={busy} onClick={() => void check()}>
          <RefreshCw size={16} />
          Check again
        </Button>
        <Button variant="quiet" onClick={onEdit}>
          <Pencil size={16} />
          Edit
        </Button>
        <Button variant="quiet" onClick={onRemove}>
          <Unplug size={16} />
          Disconnect
        </Button>
      </div>
    </ResourceRow>
  );
}

/** A server's mark: the logo of the service it fronts, when it is one we know, or a plug. */
export function McpIcon({ server }: { server: McpServer }) {
  const address =
    server.transport === 'stdio'
      ? [server.command, ...server.args].filter(Boolean).join(' ')
      : (server.url ?? '');
  const service = serviceOf(`${address} ${server.name}`.toLowerCase());

  return service ? <ProviderLogo kind={service} size={22} /> : <Plug size={20} strokeWidth={1.6} />;
}
