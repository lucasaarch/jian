'use client';

import { useState } from 'react';
import { type McpEditing, useMcpServers } from '../../components/integrations/mcp-list';
import { ConfirmDialog, SettingsGroup } from '../../kit';
import type { McpServer } from '../../lib/api';
import { useActions } from '../../lib/workspace';
import { McpDialog } from '../settings/mcp-dialog';
import { McpServerLine } from '../settings/mcp-server-line';

/**
 * The form that adds a custom connector, an MCP server of the owner's, or configures a saved
 * one, and its removal, which asks for the server's name first since its credentials go with it.
 * `editing` is the server's place in the whole list, which is what is saved: Jian's own servers
 * are in it too, and keep their places. `onDone` is told once a change is saved.
 */
export function McpEditor({
  editing,
  open,
  onOpenChange,
  onDone,
}: {
  editing: McpEditing;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const { api, mutate, busy } = useActions();
  const { servers, save, remove } = useMcpServers({ api, mutate });
  // Every opening starts from the server, with nothing left of the one before.
  const [was, setWas] = useState(open);
  const [round, setRound] = useState(0);
  const [failed, setFailed] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) {
      setRound(round + 1);
      setFailed(false);
    }
  }
  // By name: once the list is saved without it, its place belongs to the next server.
  const [removing, setRemoving] = useState('');
  const [asking, setAsking] = useState(false);
  const server = editing === 'new' ? undefined : servers[editing];

  return (
    <>
      <McpDialog
        open={open}
        onOpenChange={onOpenChange}
        round={round}
        api={api}
        busy={busy}
        error={failed ? 'Could not save. Check the fields, or refresh the page.' : ''}
        onSave={(next) =>
          void save(next, editing).then((ok) => {
            setFailed(!ok);
            if (!ok) return;
            onOpenChange(false);
            onDone?.();
          })
        }
        {...(server
          ? {
              server,
              onRemove: () => {
                setRemoving(server.name);
                setAsking(true);
              },
            }
          : {})}
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Remove ${removing}?`}
        phrase={removing}
        action="Remove server"
        busy={busy}
        run={() => {
          const index = servers.findIndex((item) => item.name === removing);
          if (index < 0) return;
          void remove(index).then((ok) => {
            if (!ok) return;
            setAsking(false);
            onOpenChange(false);
            onDone?.();
          });
        }}
      >
        Every agent stops reaching it on its next runs, and its credentials are deleted. This cannot
        be undone.
      </ConfirmDialog>
    </>
  );
}

/**
 * One custom connector, opened from its row: its name, whether it answers, asked of it as this
 * opens, and how many tools its agents are offered; everything else behind Configure. Saving or
 * removing it closes this too, as the row it was opened from may no longer be the same one.
 */
export function CustomConnector({ server, close }: { server: McpServer; close: () => void }) {
  const { api, mutate } = useActions();
  const { servers } = useMcpServers({ api, mutate });
  const [configuring, setConfiguring] = useState(false);

  return (
    <>
      <SettingsGroup>
        <McpServerLine api={api} server={server} onConfigure={() => setConfiguring(true)} />
      </SettingsGroup>
      <McpEditor
        // Gone from the list once removed, while this closes: there is then nothing to edit.
        editing={servers.findIndex((item) => item.name === server.name)}
        open={configuring}
        onOpenChange={setConfiguring}
        onDone={close}
      />
    </>
  );
}
