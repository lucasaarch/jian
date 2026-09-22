import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import type { McpServer, McpValue } from '@jian/contracts';
import { mcpSecret } from '../profiles/service.js';
import type { Vault } from '../security/vault.js';
import { stdioTransport } from './mcp-stdio.js';

/**
 * Where one of a server's values lives in the vault. The header or variable name is part of the
 * address, so removing a header removes its secret and two servers never share one.
 */
export const mcpValueSecret = (server: string, kind: 'header' | 'env', name: string) =>
  `${mcpSecret(server)}:${kind}:${name}`;

export type SecretReader = Pick<Vault, 'read'>;

/** A value the owner typed, or one the host environment carries. Absent means not configured. */
async function resolve(
  profileId: string,
  server: string,
  kind: 'header' | 'env',
  value: McpValue,
  vault: SecretReader,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (value.fromEnv) {
    return env[value.fromEnv]?.trim() || undefined;
  }

  return vault.read(profileId, mcpValueSecret(server, kind, value.name));
}

export class MissingMcpValue extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

async function collect(
  profileId: string,
  server: McpServer,
  kind: 'header' | 'env',
  values: McpValue[],
  vault: SecretReader,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const value of values) {
    const secret = await resolve(profileId, server.name, kind, value, vault, env);

    if (secret === undefined) {
      throw new MissingMcpValue(
        value.fromEnv
          ? `${value.fromEnv} is not set on this gateway`
          : `${value.name} has no value configured`,
      );
    }

    resolved[value.name] = secret;
  }

  return resolved;
}

export type McpConnection = {
  profileId: string;
  server: McpServer;
  vault: SecretReader;
  fetcher: typeof globalThis.fetch;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Present only for a server the owner signed in to; the SDK drives the whole exchange. */
  authProvider?: Parameters<typeof createMCPClient>[0]['transport'] extends infer T
    ? T extends { authProvider?: infer A }
      ? A
      : never
    : never;
};

/** Opens a client for one configured server, whatever transport and auth it was given. */
export async function connectMcp(connection: McpConnection): Promise<MCPClient> {
  const { profileId, server, vault, fetcher, signal } = connection;
  const env = connection.env ?? process.env;

  if (server.transport === 'stdio') {
    return createMCPClient({
      transport: stdioTransport({
        command: server.command as string,
        args: server.args,
        env: await collect(profileId, server, 'env', server.env, vault, env),
        signal,
      }),
      initializationOptions: { signal, timeout: 15_000 },
      maxRetries: 0,
    });
  }

  const headers =
    server.auth === 'headers'
      ? await collect(profileId, server, 'header', server.headers, vault, env)
      : undefined;

  return createMCPClient({
    transport: {
      type: 'http',
      url: server.url as string,
      ...(headers ? { headers } : {}),
      ...(connection.authProvider ? { authProvider: connection.authProvider } : {}),
      fetch: fetcher,
      redirect: 'error',
    },
    initializationOptions: { signal, timeout: 15_000 },
    maxRetries: 0,
  });
}
