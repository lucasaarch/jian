'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { McpServer, McpValue } from '../../lib/api';
import { Button, Field, Modal, StackedFields } from '../ui';
import { Select } from '../ui/select';

type Draft = {
  name: string;
  transport: 'http' | 'stdio';
  url: string;
  auth: 'none' | 'headers' | 'oauth';
  headers: McpValue[];
  command: string;
  args: string;
  env: McpValue[];
};

/** A value already stored carries no `value`: the panel cannot read it and must not clear it. */
const blank = (): McpValue => ({ name: '', value: '' });

function draftOf(server?: McpServer): Draft {
  return {
    name: server?.name ?? '',
    transport: server?.transport ?? 'http',
    url: server?.url ?? '',
    auth: server?.auth ?? 'none',
    headers: server?.headers.length ? server.headers : [blank()],
    command: server?.command ?? '',
    args: (server?.args ?? []).join(' '),
    env: server?.env ?? [],
  };
}

/** Drops the rows the owner left empty and the values they did not retype. */
const clean = (values: McpValue[]): McpValue[] =>
  values
    .filter((value) => value.name.trim())
    .map((value) => ({
      name: value.name.trim(),
      ...(value.value ? { value: value.value } : {}),
      ...(value.fromEnv ? { fromEnv: value.fromEnv } : {}),
    }));

export function McpForm({
  server,
  busy,
  error,
  onSave,
  onClose,
}: {
  server?: McpServer;
  busy: boolean;
  error: string;
  onSave: (server: McpServer) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(server));
  const change = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const values = (kind: 'headers' | 'env') => ({
    list: draft[kind],
    set: (list: McpValue[]) => change({ [kind]: list } as Partial<Draft>),
  });

  return (
    <Modal
      title="MCP server"
      close={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="mcp-form" busy={busy}>
            Save server
          </Button>
        </>
      }
    >
      <form
        id="mcp-form"
        method="post"
        action="/ui/"
        onSubmit={(event) => {
          event.preventDefault();

          onSave({
            name: draft.name.trim(),
            transport: draft.transport,
            auth: draft.transport === 'stdio' ? 'none' : draft.auth,
            ...(draft.transport === 'http'
              ? {
                  url: draft.url.trim(),
                  headers: draft.auth === 'headers' ? clean(draft.headers) : [],
                }
              : { headers: [] }),
            ...(draft.transport === 'stdio'
              ? {
                  command: draft.command.trim(),
                  args: draft.args.split(/\s+/).filter(Boolean),
                  env: clean(draft.env),
                }
              : { args: [], env: [] }),
          } as McpServer);
        }}
      >
        <Field label="Name" hint="Lowercase letters, digits and underscore.">
          <input
            name="name"
            required
            pattern="[a-z0-9_]{1,30}"
            value={draft.name}
            onChange={(event) => change({ name: event.target.value })}
          />
        </Field>

        <Field label="Transport" hint="How the gateway reaches this server.">
          <Select
            value={draft.transport}
            disabled={busy}
            onValueChange={(transport) =>
              change({ transport: transport as Draft['transport'], auth: 'none' })
            }
            options={[
              { value: 'http', label: 'HTTP endpoint' },
              { value: 'stdio', label: 'A command on this machine' },
            ]}
          />
        </Field>

        {draft.transport === 'http' ? (
          <>
            <Field label="HTTP endpoint">
              <input
                type="url"
                required
                value={draft.url}
                placeholder="https://mcp.example.com/mcp"
                onChange={(event) => change({ url: event.target.value })}
              />
            </Field>
            <Field label="Authentication">
              <Select
                value={draft.auth}
                disabled={busy}
                onValueChange={(auth) => change({ auth: auth as Draft['auth'] })}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'headers', label: 'Headers you write' },
                  { value: 'oauth', label: 'Sign in to the server (OAuth)' },
                ]}
              />
            </Field>
            {draft.auth === 'headers' && (
              <ValueRows
                label="Headers"
                hint="Write the header itself: Authorization with Bearer, with Basic, or anything the server asks for."
                placeholder="Authorization"
                stored={server?.headers ?? []}
                busy={busy}
                {...values('headers')}
              />
            )}
            {draft.auth === 'oauth' && (
              <p className="note">
                Save the server, then use <strong>Test the connection</strong> — it answers with the
                link to sign in.
              </p>
            )}
          </>
        ) : (
          <>
            <Field label="Command" hint="Runs with the privileges of whoever started the gateway.">
              <input
                required
                value={draft.command}
                placeholder="npx"
                onChange={(event) => change({ command: event.target.value })}
              />
            </Field>
            <Field label="Arguments" hint="Separated by spaces.">
              <input
                value={draft.args}
                placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                onChange={(event) => change({ args: event.target.value })}
              />
            </Field>
            <ValueRows
              label="Environment"
              hint="Most servers read their credential from a variable."
              placeholder="API_KEY"
              stored={server?.env ?? []}
              busy={busy}
              {...values('env')}
            />
          </>
        )}

        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

/** Name and value pairs, where a value already saved shows as kept rather than as empty. */
function ValueRows({
  label,
  hint,
  placeholder,
  list,
  stored,
  busy,
  set,
}: {
  label: string;
  hint: string;
  placeholder: string;
  list: McpValue[];
  stored: McpValue[];
  busy: boolean;
  set: (list: McpValue[]) => void;
}) {
  const update = (index: number, patch: Partial<McpValue>) =>
    set(list.map((value, at) => (at === index ? { ...value, ...patch } : value)));

  return (
    <Field label={label} hint={hint}>
      <div className="value-rows">
        {list.map((value, index) => (
          <StackedFields
            // biome-ignore lint/suspicious/noArrayIndexKey: a row is identified by its position.
            key={index}
            action={
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${value.name || label}`}
                disabled={busy}
                onClick={() => set(list.filter((_, at) => at !== index))}
              >
                <Trash2 size={15} />
              </button>
            }
          >
            <input
              value={value.name}
              placeholder={placeholder}
              aria-label={`${label} name`}
              onChange={(event) => update(index, { name: event.target.value })}
            />
            <input
              type="password"
              autoComplete="off"
              value={value.value ?? ''}
              aria-label={`${label} value`}
              placeholder={
                stored.some((item) => item.name === value.name && !item.fromEnv)
                  ? 'Saved — leave blank to keep'
                  : 'Value'
              }
              onChange={(event) => update(index, { value: event.target.value })}
            />
          </StackedFields>
        ))}
        <button
          type="button"
          className="text-button"
          disabled={busy || list.length >= 10}
          onClick={() => set([...list, blank()])}
        >
          <Plus size={14} />
          Add another
        </button>
      </div>
    </Field>
  );
}
