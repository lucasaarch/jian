'use client';

import { SettingsGroup, SettingsPageSkeleton, SettingsRowSkeleton } from '../../kit';
import { useActions } from '../../lib/workspace';
import { McpCard } from './mcp-card';

/** The MCP servers while they are read: a server and the row that adds one. */
export function McpServersWaiting() {
  return (
    <SettingsPageSkeleton label="Loading MCP servers…">
      <SettingsGroup title="MCP servers">
        <SettingsRowSkeleton pill />
        <SettingsRowSkeleton index={1} />
      </SettingsGroup>
    </SettingsPageSkeleton>
  );
}

/** The MCP servers the owner adds by hand, shared by every agent. */
export function McpServersPage() {
  return <McpCard {...useActions()} />;
}
