import type { MCPClient } from '@ai-sdk/mcp';
import type { McpServer, McpValue } from '@jian/contracts';
import type { GatewayVault } from '../security/gateway-vault.js';
import { createNegotiatedMcpClient } from './mcp-negotiate.js';
import { stdioTransport } from './mcp-stdio.js';

/**
 * Where a server's secrets live in the installation's vault, addressed by the server's name.
 * The bare address is the single bearer token of servers configured before headers existed.
 */
export const mcpSecret = (name: string) => `mcp:${name}`;

/**
 * Where one of a server's values lives in the vault. The header or variable name is part of the
 * address, so removing a header removes its secret and two servers never share one.
 */
export const mcpValueSecret = (server: string, kind: 'header' | 'env', name: string) =>
  `${mcpSecret(server)}:${kind}:${name}`;

/** Pre-registered OAuth client secret for a server that cannot use dynamic registration. */
export const mcpOauthClientSecretKey = (server: string) =>
  `${mcpSecret(server)}:oauth:client_secret`;

export type SecretReader = Pick<GatewayVault, 'read'>;

/** A value the owner typed, or one the host environment carries. Absent means not configured. */
async function resolve(
  server: string,
  kind: 'header' | 'env',
  value: McpValue,
  vault: SecretReader,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (value.fromEnv) {
    return env[value.fromEnv]?.trim() || undefined;
  }

  return vault.read(mcpValueSecret(server, kind, value.name));
}

export class MissingMcpValue extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

async function collect(
  server: McpServer,
  kind: 'header' | 'env',
  values: McpValue[],
  vault: SecretReader,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const value of values) {
    const secret = await resolve(server.name, kind, value, vault, env);

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

/**
 * How long a command has to answer, in ms. Its first run may be `npx -y` downloading it, and one
 * killed halfway leaves nothing cached, so a short limit would fail the same way for ever.
 */
export const STDIO_START_MS = 60_000;

/** How much of what a command says on stderr to hold, in characters. */
const HELD = 8_000;
/** How much of it reaches the owner, in characters: a status has room for 300 in all. */
const LAST_WORDS = 220;

/**
 * The last thing a failed command said, without any value it was given. Redacted before it is cut,
 * so a cut can never leave part of a value behind.
 */
function lastWords(said: string, env: Record<string, string>): string {
  const clean = Object.values(env).reduce(
    (text, value) => (value ? text.replaceAll(value, '[REDACTED]') : text),
    said,
  );
  return clean.trim().replace(/\s+/g, ' ').slice(-LAST_WORDS);
}

export type McpConnection = {
  server: McpServer;
  vault: SecretReader;
  fetcher: typeof globalThis.fetch;
  /** Bounds connect and initialize only — must not kill a stdio child that already answered. */
  signal: AbortSignal;
  /**
   * Lifetime of a stdio child. Defaults to `signal`. Callers that pass a connect timeout on
   * `signal` must set this to the run abort alone, or the timeout ends the server mid-turn.
   */
  lifetime?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Present only for a server the owner signed in to; the SDK drives the whole exchange. */
  authProvider?: Parameters<typeof createNegotiatedMcpClient>[0]['transport'] extends infer T
    ? T extends { authProvider?: infer A }
      ? A
      : never
    : never;
};

/** Opens a client for one configured server, whatever transport and auth it was given. */
export async function connectMcp(connection: McpConnection): Promise<MCPClient> {
  const { server, vault, fetcher, signal } = connection;
  const env = connection.env ?? process.env;

  if (server.transport === 'stdio') {
    const values = await collect(server, 'env', server.env, vault, env);
    let said = '';
    try {
      return await createNegotiatedMcpClient({
        transport: stdioTransport({
          command: server.command as string,
          args: server.args,
          env: values,
          signal: connection.lifetime ?? signal,
          said: (text) => {
            said = (said + text).slice(-HELD);
          },
        }),
        initializationOptions: { signal, timeout: STDIO_START_MS },
        maxRetries: 0,
      });
    } catch (error) {
      // Only the command knows why it did not answer: a login it waits for, a package not found.
      const words = lastWords(said, values);
      const reason = error instanceof Error ? error.message : 'The command did not answer';
      throw words ? new Error(`${reason}. The command said: ${words}`) : error;
    }
  }

  const headers =
    server.auth === 'headers'
      ? await collect(server, 'header', server.headers, vault, env)
      : undefined;

  return createNegotiatedMcpClient({
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
