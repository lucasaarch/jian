'use client';

import { useSuspenseQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { GatewayApi, McpServer } from '../../lib/api';
import { queries } from '../../lib/query/profile';
import type { SectionActions } from '../props';

/** Which server a form edits: its place in the list, or a new one. */
export type McpEditing = number | 'new';

/**
 * The installation's MCP servers and what changes them. The list is saved whole, and a value the
 * form leaves out of a header keeps the stored one. Each change resolves false when it failed,
 * after saying so.
 */
export function useMcpServers({ api, mutate }: Pick<SectionActions, 'api' | 'mutate'>) {
  const servers = useSuspenseQuery(queries.mcpServers()).data;
  const replace = (next: McpServer[], message: string) =>
    mutate(() => api.replaceMcpServers(next), message);

  const save = async (next: McpServer, editing: McpEditing) => {
    // Opened while the click still counts as one: a tab opened once the save returns would be
    // blocked as a popup. It waits blank until the gateway says where the sign-in is.
    const tab = next.auth === 'oauth' ? window.open('', '_blank') : null;
    const updated =
      editing === 'new'
        ? [...servers, next]
        : servers.map((item, index) => (index === editing ? next : item));
    const ok = await replace(updated, 'Saved.');

    if (!ok) {
      tab?.close();
      return false;
    }

    if (next.auth === 'oauth') void signIn(api, next.name, tab);
    return true;
  };

  const remove = (index: number) =>
    replace(
      servers.filter((_, at) => at !== index),
      'Removed.',
    );

  /** Switches one of a server's tools off for every agent, or on again. */
  const toggleTool = (server: McpServer, tool: string) => {
    const off = server.disabledTools ?? [];

    return replace(
      servers.map((item) =>
        item.name === server.name
          ? {
              ...item,
              disabledTools: off.includes(tool)
                ? off.filter((name) => name !== tool)
                : [...off, tool],
            }
          : item,
      ),
      off.includes(tool) ? `${tool} switched on.` : `${tool} switched off.`,
    );
  };

  return { servers, save, remove, toggleTool };
}

/**
 * A check of the saved server is what starts its sign-in and answers with the address. With no
 * tab opened beforehand — a blocked popup, or a desktop app that opens sign-ins in the system's
 * browser — the address is opened now instead.
 */
async function signIn(api: GatewayApi, name: string, tab: Window | null) {
  const status = await api.checkMcpServer(name).catch(() => undefined);

  if (status?.authorizationUrl) {
    if (!tab) {
      window.open(status.authorizationUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    // The sign-in page is someone else's: it gets no handle on this one.
    tab.opener = null;
    tab.location.href = status.authorizationUrl;
    return;
  }

  tab?.close();
  // Already signed in needs nothing; anything else is said where the owner is looking.
  if (!status?.reachable) {
    toast.error(
      `${name} did not connect — ${(status?.error ?? 'the check could not run').replace(/\.$/, '')}.`,
      { duration: 8000 },
    );
  }
}
