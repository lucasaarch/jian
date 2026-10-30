'use client';

import { useEffect, useEffectEvent } from 'react';
import { useMcpCheck } from '../../components/integrations/mcp-check';
import { mcpHealth } from '../../components/integrations/mcp-health';
import { Action, SettingsRow, StatusPill } from '../../kit';
import type { GatewayApi, McpServer } from '../../lib/api';

/**
 * One saved server, a line: its name, whether it answers — asked of it as the page opens — and
 * how many tools its agents are offered; everything else behind Configure.
 */
export function McpServerLine({
  api,
  server,
  onConfigure,
}: {
  api: GatewayApi;
  server: McpServer;
  onConfigure: () => void;
}) {
  const check = useMcpCheck(() => api.checkMcpServer(server.name));
  const ask = useEffectEvent(() => void check.check());
  useEffect(() => ask(), []);
  const health = mcpHealth(check, server.disabledTools ?? []);

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <span className="truncate">{server.name}</span>
          {health && (
            <span role="status" className="flex items-center gap-1.5">
              <StatusPill tone={health.tone === 'neutral' ? 'quiet' : health.tone}>
                {health.label}
              </StatusPill>
              {health.tools && <StatusPill>{health.tools}</StatusPill>}
            </span>
          )}
        </span>
      }
    >
      <Action
        tone="outline"
        size="small"
        aria-label={`Configure ${server.name}`}
        onClick={onConfigure}
      >
        Configure
      </Action>
    </SettingsRow>
  );
}
