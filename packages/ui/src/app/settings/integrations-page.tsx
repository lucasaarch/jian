'use client';

import { useActions } from '../../lib/workspace';
import { AppsCard } from './github-card';
import { McpCard } from './mcp-card';

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
