'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import { type McpEditing, useMcpServers } from '../../components/integrations/mcp-list';
import type { SectionActions } from '../../components/props';
import { Action, ConfirmDialog, SettingsGroup, SettingsRow } from '../../kit';
import { McpDialog } from './mcp-dialog';
import { McpServerLine } from './mcp-server-line';

/**
 * The installation's MCP servers, a line each — its name, whether it answers and its tools'
 * count — with Configure, and the way to add another. Every agent reaches each of them; removing one asks for its name first, since its
 * credentials go with it.
 */
export function McpCard({ api, mutate, busy }: SectionActions) {
  const { servers, save, remove } = useMcpServers({ api, mutate });
  // What the form edits stays set while it closes, so it fades out as it was.
  const [editing, setEditing] = useState<McpEditing>('new');
  const [formOpen, setFormOpen] = useState(false);
  const [round, setRound] = useState(0);
  const [failed, setFailed] = useState(false);
  // By name: once the list is saved without it, its place belongs to the next server.
  const [removing, setRemoving] = useState('');
  const [asking, setAsking] = useState(false);

  const edit = (target: McpEditing) => {
    setEditing(target);
    setFailed(false);
    setRound((count) => count + 1);
    setFormOpen(true);
  };

  return (
    <>
      <SettingsGroup title="MCP servers">
        {servers.map((server, index) => (
          <McpServerLine
            key={server.name}
            api={api}
            server={server}
            onConfigure={() => edit(index)}
          />
        ))}
        <SettingsRow
          title={servers.length ? 'Add a server' : 'No servers yet'}
          {...(servers.length
            ? {}
            : {
                description:
                  'Give the address of an MCP server: every agent reaches it, and loads the tools it needs.',
              })}
        >
          <Action tone="outline" size="small" onClick={() => edit('new')}>
            <Plus size={13} />
            Add server
          </Action>
        </SettingsRow>
      </SettingsGroup>
      <McpDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        round={round}
        api={api}
        server={editing === 'new' ? undefined : servers[editing]}
        busy={busy}
        error={failed ? 'Could not save. Check the fields, or refresh the page.' : ''}
        onSave={(next) =>
          void save(next, editing).then((ok) => {
            setFailed(!ok);
            if (ok) setFormOpen(false);
          })
        }
        {...(editing === 'new' || !servers[editing]
          ? {}
          : {
              onRemove: () => {
                setRemoving(servers[editing as number]?.name ?? '');
                setAsking(true);
              },
            })}
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Remove ${removing}?`}
        phrase={removing}
        action="Remove server"
        busy={busy}
        run={() => {
          const index = servers.findIndex((server) => server.name === removing);
          if (index < 0) return;
          void remove(index).then((ok) => {
            if (!ok) return;
            setAsking(false);
            setFormOpen(false);
          });
        }}
      >
        Every agent stops reaching it on its next runs, and its credentials are deleted. This cannot
        be undone.
      </ConfirmDialog>
    </>
  );
}
