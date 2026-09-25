'use client';

import { Check, Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { GatewayApi, Profile } from '../../lib/api';

type Imported = Awaited<ReturnType<GatewayApi['importMcpServers']>>;

import { Avatar } from '../profile/avatar-field';
import { Button, Field, Modal } from '../ui';
import { Select } from '../ui/select';
import { McpIcon } from './mcp-row';

/**
 * Copies servers another agent already has. Each copy is this agent's own, credentials
 * included, so it is set up once and then changed or removed here without touching the other.
 */
export function McpImport({
  profile,
  sources,
  close,
  importServers,
}: {
  profile: Profile;
  /** The other profiles that have servers to offer. */
  sources: Profile[];
  close: () => void;
  /** Imports and refreshes the profile; undefined when it failed, already reported. */
  importServers: (fromProfileId: string, servers: string[]) => Promise<Imported | undefined>;
}) {
  const [fromId, setFromId] = useState(sources[0]?.id ?? '');
  const from = sources.find((item) => item.id === fromId);
  const taken = new Set(profile.mcpServers.map((server) => server.name));
  const offered = from?.mcpServers ?? [];
  // What can come across: a name this agent already has stays behind.
  const available = offered.filter((server) => !taken.has(server.name));
  const [chosen, setChosen] = useState<Set<string>>(
    () =>
      new Set(
        (sources[0]?.mcpServers ?? [])
          .map((server) => server.name)
          .filter((name) => !taken.has(name)),
      ),
  );
  const [busy, setBusy] = useState(false);
  const everything = available.length > 0 && available.every((server) => chosen.has(server.name));

  return (
    <Modal
      title="Import from another agent"
      description="Each server is copied with its credentials and becomes this agent's own. Changing it here never changes the other agent."
      close={close}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="mcp-import-form" busy={busy} disabled={!chosen.size}>
            <Download size={16} />
            Import {chosen.size === 1 ? '1 server' : `${chosen.size} servers`}
          </Button>
        </>
      }
    >
      <form
        id="mcp-import-form"
        className="grid gap-5"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);

          const result = await importServers(fromId, [...chosen]);

          setBusy(false);

          if (!result) return;

          // A sign-in stays with the agent that made it: said here, so it is not a surprise.
          if (result.signIn.length)
            toast.info(
              `Sign in for ${result.signIn.join(', ')} from its row: a sign-in is not copied.`,
              {
                duration: 12_000,
              },
            );
          close();
        }}
      >
        <Field label="From">
          <Select
            value={fromId}
            onValueChange={(value) => {
              setFromId(value);
              setChosen(
                new Set(
                  (sources.find((item) => item.id === value)?.mcpServers ?? [])
                    .map((server) => server.name)
                    .filter((name) => !taken.has(name)),
                ),
              );
            }}
            options={sources.map((item) => ({
              value: item.id,
              label: item.name,
              detail: `${item.mcpServers.length} ${item.mcpServers.length === 1 ? 'server' : 'servers'}`,
              icon: <Avatar name={item.name} avatar={item.avatar} className="mini-avatar" />,
            }))}
            aria-label="Agent to import from"
          />
        </Field>
        <fieldset className="import-servers">
          <legend>
            Servers
            {available.length > 1 && (
              <button
                type="button"
                className="text-link"
                onClick={() =>
                  setChosen(
                    everything ? new Set() : new Set(available.map((server) => server.name)),
                  )
                }
              >
                {everything ? 'Select none' : 'Select all'}
              </button>
            )}
          </legend>
          {offered.map((server) => {
            const exists = taken.has(server.name);
            const selected = !exists && chosen.has(server.name);

            return (
              <button
                type="button"
                key={server.name}
                className="import-server"
                aria-pressed={selected}
                disabled={exists}
                onClick={() =>
                  setChosen((current) => {
                    const next = new Set(current);

                    if (next.has(server.name)) next.delete(server.name);
                    else next.add(server.name);

                    return next;
                  })
                }
              >
                <span className="import-server-icon" aria-hidden="true">
                  <McpIcon server={server} />
                </span>
                <span className="import-server-copy">
                  <strong>{server.name}</strong>
                  <small>
                    {server.transport === 'stdio'
                      ? `Runs ${server.command ?? 'a command'} on this machine`
                      : (server.url ?? '')}
                  </small>
                  {exists ? (
                    <small className="import-server-note">
                      This agent already has a server with this name
                    </small>
                  ) : server.auth === 'oauth' ? (
                    <small className="import-server-note">
                      Needs its own sign-in after importing
                    </small>
                  ) : null}
                </span>
                <span className="import-server-check" aria-hidden="true">
                  {selected && <Check size={14} strokeWidth={3} />}
                </span>
              </button>
            );
          })}
        </fieldset>
      </form>
    </Modal>
  );
}
