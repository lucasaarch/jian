'use client';

import { useSuspenseQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { McpServer } from '../../lib/api';
import { queries } from '../../lib/query/profile';
import type { SectionActions } from '../props';
import { Button, Confirm, Empty, SectionHeading } from '../ui';
import { McpForm } from './mcp-form';
import { McpRow } from './mcp-row';

/**
 * The installation's MCP servers: every agent reaches each of them. The list is saved whole, and
 * a value the form leaves out of a header keeps the stored one.
 */
export function McpServers({ api, mutate, busy }: SectionActions) {
  const servers = useSuspenseQuery(queries.mcpServers()).data;
  const [editing, setEditing] = useState<number | 'new'>();
  const [removing, setRemoving] = useState<number>();
  const [failed, setFailed] = useState(false);
  const replace = (next: McpServer[], message: string) =>
    mutate(() => api.replaceMcpServers(next), message);

  const save = async (next: McpServer) => {
    // Opened while the click still counts as one: a tab opened once the save returns would be
    // blocked as a popup. It waits blank until the gateway says where the sign-in is.
    const tab = next.auth === 'oauth' ? window.open('', '_blank') : null;
    const updated =
      editing === 'new'
        ? [...servers, next]
        : servers.map((item, index) => (index === editing ? next : item));
    const ok = await replace(updated, 'Saved.');

    setFailed(!ok);
    if (!ok) {
      tab?.close();
      return;
    }

    setEditing(undefined);
    if (next.auth === 'oauth') await signIn(next.name, tab);
  };

  // A check of the saved server is what starts its sign-in and answers with the address. With
  // no tab opened beforehand — a blocked popup, or a desktop app that opens sign-ins in the
  // system's browser — the address is opened now instead.
  const signIn = async (name: string, tab: Window | null) => {
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
        {
          duration: 8000,
        },
      );
    }
  };

  return (
    <>
      <SectionHeading
        title="MCP servers"
        description="Shared by every agent. Each discovers the tools a server offers and loads what it needs."
        action={
          <Button
            onClick={() => {
              setFailed(false);
              setEditing('new');
            }}
          >
            <Plus size={16} />
            Connect a server
          </Button>
        }
      />
      {servers.length ? (
        <div className="resource-list">
          {servers.map((item, index) => (
            <McpRow
              key={item.name}
              server={item}
              api={api}
              onEdit={() => {
                setFailed(false);
                setEditing(index);
              }}
              onRemove={() => setRemoving(index)}
              saving={busy}
              onToggleTool={(tool) => {
                const off = item.disabledTools ?? [];

                void replace(
                  servers.map((server) =>
                    server.name === item.name
                      ? {
                          ...server,
                          disabledTools: off.includes(tool)
                            ? off.filter((name) => name !== tool)
                            : [...off, tool],
                        }
                      : server,
                  ),
                  off.includes(tool) ? `${tool} switched on.` : `${tool} switched off.`,
                );
              }}
            />
          ))}
        </div>
      ) : (
        <Empty title="Connect a tool">
          Give the address of an MCP server. The tools come from it, and every agent loads one
          before it can call it.
        </Empty>
      )}
      {editing !== undefined && (
        <McpForm
          api={api}
          server={typeof editing === 'number' ? servers[editing] : undefined}
          busy={busy}
          error={failed ? 'Could not save. Check the fields, or refresh the page.' : ''}
          onSave={(next) => void save(next)}
          onClose={() => setEditing(undefined)}
        />
      )}
      {removing !== undefined && (
        <Confirm
          title="Disconnect this server?"
          description="Every agent stops reaching it on its next runs, and its credentials are deleted."
          busy={busy}
          close={() => setRemoving(undefined)}
          confirm={async () => {
            if (
              await replace(
                servers.filter((_, index) => index !== removing),
                'Removed.',
              )
            ) {
              setRemoving(undefined);
            }
          }}
        />
      )}
    </>
  );
}
