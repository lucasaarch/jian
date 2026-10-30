'use client';

import { SettingsGroup, SettingsPageSkeleton, SettingsRowSkeleton } from '../../kit';
import { useActions } from '../../lib/workspace';
import { AppsCard } from './github-card';
import { McpCard } from './mcp-card';

/** The integrations while the MCP servers are read: GitHub's row, a server and the row that adds. */
export function IntegrationsWaiting() {
  return (
    <SettingsPageSkeleton label="Loading integrations…">
      <SettingsGroup title="Apps">
        <SettingsRowSkeleton index={3} pill />
      </SettingsGroup>
      <SettingsGroup title="MCP servers">
        <SettingsRowSkeleton pill />
        <SettingsRowSkeleton index={1} />
      </SettingsGroup>
    </SettingsPageSkeleton>
  );
}

/**
 * The gateway's integrations, shared by every agent: the apps it connects, GitHub so far, and
 * the MCP servers the owner adds.
 */
export function IntegrationsPage() {
  const actions = useActions();

  return (
    <>
      <AppsCard api={actions.api} />
      <McpCard {...actions} />
    </>
  );
}
