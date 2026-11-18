'use client';

import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { draftOf, type McpDraft, serverOf } from '../../components/integrations/mcp-draft';
import { Segmented, TextField } from '../../kit';
import type { GatewayApi, McpServer, McpValue } from '../../lib/api';
import { McpValues } from '../settings/mcp-values';

/**
 * What a form of an MCP server holds while it is written: the fields as typed, starting from
 * `server` or empty for a new one, the server they make, and a test of that connection before it
 * is saved. Nothing a test carries is stored, and what it answers is said in a notice, so the
 * form stays as long as its fields.
 */
export function useMcpDraft(api: GatewayApi, server?: McpServer) {
  const [draft, setDraft] = useState<McpDraft>(() => draftOf(server));
  const [testing, setTesting] = useState(false);
  // A stored OAuth client secret never comes back: it is kept unless typed again.
  const secretSaved = Boolean(server?.oauthClientSecret);
  const made = () => serverOf(draft, secretSaved);

  const test = async () => {
    setTesting(true);
    try {
      const status = await api.checkMcpDraft(made());
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

  return {
    draft,
    change: (patch: Partial<McpDraft>) => setDraft((current) => ({ ...current, ...patch })),
    secretSaved,
    made,
    testing,
    test,
  };
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

/**
 * The fields of an MCP server, for the form around them: its name, how the gateway reaches it,
 * and what goes with the calls. `server` is the saved one being changed, whose stored values
 * show as kept rather than as empty.
 */
export function McpFields({
  draft,
  change,
  secretSaved,
  server,
  busy,
}: Pick<ReturnType<typeof useMcpDraft>, 'draft' | 'change' | 'secretSaved'> & {
  server?: McpServer | undefined;
  busy: boolean;
}) {
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
    <>
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
            : 'The gateway runs it where the gateway runs, with the privileges of whoever started it. It cannot open a browser on a server, so a command that signs in that way never answers.'
        }
      >
        <Segmented
          label="Transport"
          value={draft.transport}
          options={[
            { value: 'http', label: 'HTTP endpoint' },
            { value: 'stdio', label: 'A command on the gateway' },
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
    </>
  );
}
