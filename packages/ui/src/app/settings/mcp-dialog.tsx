'use client';

import { type ReactNode, useRef, useState } from 'react';
import { toast } from 'sonner';
import { draftOf, type McpDraft, serverOf } from '../../components/integrations/mcp-draft';
import { Action, Overlay, Segmented, TextField } from '../../kit';
import type { GatewayApi, McpServer, McpValue } from '../../lib/api';
import { McpValues } from './mcp-values';

/**
 * Adds an MCP server, or configures one: its connection to change and test before saving —
 * nothing a test carries is stored — and its removal. `round` changes on every
 * opening, so each starts from the server.
 */
export function McpDialog({
  open,
  onOpenChange,
  round,
  ...form
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  round: number;
} & FormProps) {
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title={form.server ? form.server.name : 'Add an MCP server'}
      size="form"
    >
      <McpForm key={round} {...form} onCancel={() => onOpenChange(false)} />
    </Overlay>
  );
}

type FormProps = {
  api: GatewayApi;
  /** The server to configure; a new one without it. */
  server?: McpServer;
  busy: boolean;
  error: string;
  onSave: (server: McpServer) => void;
  /** The saved server removed; asked to confirm. */
  onRemove?: () => void;
};

function McpForm({
  api,
  server,
  busy,
  error,
  onSave,
  onRemove,
  onCancel,
}: FormProps & { onCancel: () => void }) {
  const [draft, setDraft] = useState<McpDraft>(() => draftOf(server));
  const form = useRef<HTMLFormElement>(null);
  const secretSaved = Boolean(server?.oauthClientSecret);
  const [testing, setTesting] = useState(false);
  const change = (patch: Partial<McpDraft>) => setDraft((current) => ({ ...current, ...patch }));

  // What a test answers is said in a notice, not in the form: the form stays as long as its fields.
  const test = async () => {
    setTesting(true);
    try {
      const status = await api.checkMcpDraft(serverOf(draft, secretSaved));
      if (status.reachable) {
        const count = status.tools.length;
        toast.success(`Connected — ${count} ${count === 1 ? 'tool' : 'tools'}.`);
      } else {
        const signIn = status.authorizationUrl;
        toast.error(
          status.error ? `Did not connect — ${status.error}` : 'Did not connect.',
          signIn
            ? {
                action: {
                  label: 'Sign in',
                  onClick: () => window.open(signIn, '_blank', 'noreferrer'),
                },
              }
            : undefined,
        );
      }
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : 'The check could not run.');
    } finally {
      setTesting(false);
    }
  };
  const values = (kind: 'headers' | 'env') => ({
    list: draft[kind],
    onChange: (list: McpValue[]) => change({ [kind]: list }),
  });
  const field = (
    key: 'name' | 'url' | 'command' | 'args' | 'oauthClientId' | 'oauthClientSecret',
  ) => ({
    value: draft[key],
    onChange: (event: { target: { value: string } }) => change({ [key]: event.target.value }),
  });

  return (
    <form
      ref={form}
      className="grid w-full gap-5 p-7"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(serverOf(draft, secretSaved));
      }}
    >
      <header className="grid gap-1 pr-6">
        <h2 className="text-lg font-semibold tracking-tight">
          {server ? server.name : 'Add an MCP server'}
        </h2>
        <p className="text-sm text-muted">
          Every agent reaches it, and loads the tools it needs from it.
        </p>
      </header>
      <TextField
        label="Name"
        hint="Lowercase letters, digits and underscore."
        required
        pattern="[a-z0-9_]{1,30}"
        autoComplete="off"
        spellCheck={false}
        {...field('name')}
      />
      <Choice
        label="Transport"
        hint={
          draft.transport === 'http'
            ? 'The gateway reaches it at an HTTP endpoint.'
            : 'The gateway runs it, with the privileges of whoever started the gateway.'
        }
      >
        <Segmented
          label="Transport"
          value={draft.transport}
          options={[
            { value: 'http', label: 'HTTP endpoint' },
            { value: 'stdio', label: 'A command on this machine' },
          ]}
          onChange={(transport) => change({ transport, auth: 'none' })}
        />
      </Choice>
      {draft.transport === 'http' ? (
        <>
          <TextField
            label="HTTP endpoint"
            type="url"
            required
            placeholder="https://mcp.example.com/mcp"
            autoComplete="off"
            {...field('url')}
          />
          <Choice label="Authentication" hint={authHints[draft.auth]}>
            <Segmented
              label="Authentication"
              value={draft.auth}
              options={[
                { value: 'none', label: 'None' },
                { value: 'headers', label: 'Headers' },
                { value: 'oauth', label: 'OAuth' },
              ]}
              onChange={(auth) => change({ auth })}
            />
          </Choice>
          {draft.auth === 'headers' && (
            <McpValues
              label="Headers"
              hint="Write the header itself: Authorization with Bearer, with Basic, or anything the server asks for."
              placeholder="Authorization"
              stored={server?.headers ?? []}
              busy={busy}
              {...values('headers')}
            />
          )}
          {draft.auth === 'oauth' && (
            <>
              <TextField
                label="OAuth client id"
                hint="Required when the auth server has no dynamic registration (for example GitHub Copilot MCP). Create an OAuth App whose callback is this gateway MCP OAuth callback, then paste the client id. Leave blank when the server registers Jian itself."
                autoComplete="off"
                spellCheck={false}
                placeholder="Iv1.… or OAuth App client id"
                {...field('oauthClientId')}
              />
              <TextField
                label="OAuth client secret"
                hint="Required by GitHub OAuth Apps. Public PKCE clients leave this blank."
                type="password"
                autoComplete="off"
                placeholder={secretSaved ? 'Saved — leave blank to keep' : 'Client secret'}
                {...field('oauthClientSecret')}
              />
            </>
          )}
        </>
      ) : (
        <>
          <TextField
            label="Command"
            required
            placeholder="npx"
            autoComplete="off"
            spellCheck={false}
            {...field('command')}
          />
          <TextField
            label="Arguments"
            hint="Separated by spaces."
            placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
            autoComplete="off"
            spellCheck={false}
            {...field('args')}
          />
          <McpValues
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
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        {server && onRemove && (
          <Action tone="danger" className="bg-bad/10" disabled={busy} onClick={onRemove}>
            Remove
          </Action>
        )}
        <Action
          tone="outline"
          busy={testing}
          disabled={busy}
          onClick={() => {
            if (form.current?.reportValidity()) void test();
          }}
        >
          Test
        </Action>
        <span className="flex-1" />
        <Action tone="quiet" onClick={onCancel}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy}>
          {server ? 'Save' : 'Add server'}
        </Action>
      </div>
    </form>
  );
}

/** What each way of signing in asks of the owner. */
const authHints: Record<McpDraft['auth'], string> = {
  none: 'Nothing goes with the calls to say who makes them.',
  headers: 'Headers you write go with every call.',
  oauth: 'Saving opens the server’s sign-in in a new tab. Needs JIAN_PUBLIC_URL.',
};

/** One of a few choices, under its name, as the kit's fields are. */
function Choice({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="grid justify-items-start gap-1.5">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
      <small className="text-xs leading-snug text-muted">{hint}</small>
    </div>
  );
}
