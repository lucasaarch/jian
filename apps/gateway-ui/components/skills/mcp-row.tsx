'use client';

import { Pencil, Plug, Trash2 } from 'lucide-react';
import type { GatewayApi, McpServer, Profile } from '../../lib/api';
import { McpCheckButton, McpResult, useMcpCheck } from './mcp-check';

/**
 * One connected server. The three actions sit together on the right and stay at the top of the
 * row, so the answer to a check can grow underneath without pushing them out of reach.
 */
export function McpRow({
  server,
  profile,
  api,
  onEdit,
  onRemove,
}: {
  server: McpServer;
  profile: Profile;
  api: GatewayApi;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { status, error, busy, check } = useMcpCheck(profile, server.name, api);

  return (
    <article className="resource-row items-start">
      <div className="resource-icon">
        <Plug size={20} />
      </div>
      <div className="grow">
        <h3>{server.name}</h3>
        <p className="break-all">{server.url}</p>
        <McpResult status={status} error={error} />
      </div>
      <div className="row-actions">
        <McpCheckButton name={server.name} busy={busy} onCheck={() => void check()} />
        <button
          type="button"
          className="icon-button"
          aria-label={`Edit ${server.name}`}
          onClick={onEdit}
        >
          <Pencil size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={`Remove ${server.name}`}
          onClick={onRemove}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </article>
  );
}
