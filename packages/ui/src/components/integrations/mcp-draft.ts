import type { McpServer, McpValue } from '../../lib/api';

/** An MCP server as its form holds it: every field a string, whatever the transport. */
export type McpDraft = {
  name: string;
  transport: 'http' | 'stdio';
  url: string;
  auth: 'none' | 'headers' | 'oauth';
  headers: McpValue[];
  command: string;
  args: string;
  env: McpValue[];
  oauthClientId: string;
  oauthClientSecret: string;
};

/** A value already stored carries no `value`: the panel cannot read it and must not clear it. */
export const blankValue = (): McpValue => ({ name: '', value: '' });

/** Rows of values the form offers: as many headers as the gateway keeps for one server. */
export const MAX_VALUE_ROWS = 10;

export function draftOf(server?: McpServer): McpDraft {
  return {
    name: server?.name ?? '',
    transport: server?.transport ?? 'http',
    url: server?.url ?? '',
    auth: server?.auth ?? 'none',
    headers: server?.headers.length ? server.headers : [blankValue()],
    command: server?.command ?? '',
    args: (server?.args ?? []).join(' '),
    env: server?.env ?? [],
    oauthClientId: server?.oauthClientId ?? '',
    oauthClientSecret: '',
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

/**
 * What the form holds, in the shape the gateway saves and checks. `secretSaved` keeps a stored
 * OAuth client secret the owner did not retype.
 */
export function serverOf(draft: McpDraft, secretSaved: boolean): McpServer {
  const oauthClientId = draft.oauthClientId.trim();
  const oauthClientSecret = draft.oauthClientSecret.trim();

  return {
    name: draft.name.trim(),
    transport: draft.transport,
    auth: draft.transport === 'stdio' ? 'none' : draft.auth,
    ...(draft.transport === 'http'
      ? {
          url: draft.url.trim(),
          headers: draft.auth === 'headers' ? clean(draft.headers) : [],
          ...(draft.auth === 'oauth' && oauthClientId
            ? {
                oauthClientId,
                ...(oauthClientSecret
                  ? { oauthClientSecret: { value: oauthClientSecret } }
                  : secretSaved
                    ? { oauthClientSecret: {} }
                    : {}),
              }
            : {}),
        }
      : { headers: [] }),
    ...(draft.transport === 'stdio'
      ? {
          command: draft.command.trim(),
          args: draft.args.split(/\s+/).filter(Boolean),
          env: clean(draft.env),
        }
      : { args: [], env: [] }),
  } as McpServer;
}
