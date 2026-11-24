import {
  type McpServer,
  type McpStatus,
  mcpAppOf,
  mcpDraftCheckSchema,
  mcpRenameSchema,
  mcpServerListInputSchema,
} from '@jian/contracts';
import {
  mcpOauthClientSecretKey,
  mcpSecret,
  mcpValueSecret,
  type SecretReader,
} from '../agent/mcp-connect.js';
import { accountServerName, signedInAs } from '../agent/mcp-identity.js';
import type { McpLogins } from '../agent/mcp-login.js';
import { probeMcpServer } from '../agent/mcp-probe.js';
import type { McpOAuthProviders } from '../agent/types.js';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { GATEWAY_SCOPE, type GatewayVault } from '../security/gateway-vault.js';
import type { Queryable, Store } from '../storage/database.js';
import { listMcpServers, replaceMcpServers } from './repository.js';

/** One value on its way to the vault, still carrying which server and which slot it came from. */
type TypedMcpValue = { server: string; kind: 'header' | 'env'; name: string; value: string };

/** A pre-registered OAuth client secret typed for one server. */
type OauthClientSecret = { server: string; value: string };

/** The servers as they will be stored, and the values that have to leave them. */
function stripMcpValues(servers: McpServer[]): {
  stored: McpServer[];
  values: TypedMcpValue[];
  oauthSecrets: OauthClientSecret[];
} {
  const values: TypedMcpValue[] = [];
  const oauthSecrets: OauthClientSecret[] = [];

  const stored: McpServer[] = servers.map((server) => {
    const strip = (kind: 'header' | 'env', list: McpServer['headers']) =>
      list.map((value) => {
        if (value.value) {
          values.push({ server: server.name, kind, name: value.name, value: value.value });
        }

        return { name: value.name, ...(value.fromEnv ? { fromEnv: value.fromEnv } : {}) };
      });

    const oauthClientSecret = server.oauthClientSecret
      ? (() => {
          if (server.oauthClientSecret.value) {
            oauthSecrets.push({ server: server.name, value: server.oauthClientSecret.value });
          }

          return {
            ...(server.oauthClientSecret.fromEnv
              ? { fromEnv: server.oauthClientSecret.fromEnv }
              : {}),
          };
        })()
      : undefined;

    return {
      ...server,
      headers: strip('header', server.headers),
      env: strip('env', server.env),
      ...(oauthClientSecret ? { oauthClientSecret } : {}),
    };
  });

  return { stored, values, oauthSecrets };
}

/**
 * The installation's MCP servers: every agent reaches each of them. A value typed for one is
 * kept out of the list, which every client reads, and lives in the installation's vault.
 */
export class McpServers {
  constructor(
    private readonly store: Store,
    private readonly vault: GatewayVault,
    private readonly clock: Clock = Date.now,
  ) {}

  async list(reader: Queryable = this.store.db): Promise<McpServer[]> {
    return listMcpServers(reader);
  }

  async server(name: string): Promise<McpServer> {
    const server = (await this.list()).find((item) => item.name === name);

    if (!server) throw new GatewayError(404, 'MCP server not found');

    return server;
  }

  /**
   * Replaces the whole list. A value the owner left out keeps the stored one, which is how a
   * server is edited without retyping a credential the panel cannot show; a server or a header
   * that leaves the list takes its secrets with it.
   */
  async replace(input: unknown): Promise<McpServer[]> {
    const { servers } = mcpServerListInputSchema.parse(input);

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const previous = await this.list(tx);
      const { stored, values, oauthSecrets } = stripMcpValues(servers);

      for (const { server, kind, name, value } of values) {
        await this.vault.put(mcpValueSecret(server, kind, name), value, tx);
      }

      for (const { server, value } of oauthSecrets) {
        await this.vault.put(mcpOauthClientSecretKey(server), value, tx);
      }

      for (const server of stored) {
        await this.discardStaleValues(server, previous, tx);
      }

      for (const stale of previous) {
        if (!stored.some((server) => server.name === stale.name)) {
          await this.discardValues(stale, tx);
        }
      }

      await replaceMcpServers(tx, stored, new Date(this.clock()));

      return stored;
    });
  }

  /**
   * Connects to one server now and reports what it answered, with where to sign in if asked.
   *
   * An app's server still under the name Connect gave it (\`linear\`, \`linear_2\`) is asked who
   * it is signed in as and renamed after that account (\`linear_octo\`), the way GitHub's
   * accounts are told apart; the answer then carries the new name. Agents tell one account of an
   * app from another by nothing else. A server that cannot say keeps its name.
   */
  async check(
    name: string,
    fetcher?: typeof globalThis.fetch,
    oauth?: McpOAuthProviders,
  ): ReturnType<typeof probeMcpServer> {
    const server = await this.server(name);
    const app = mcpAppOf(server.url);
    const unnamed = app !== undefined && new RegExp(`^${app}(_\\d+)?$`).test(name);
    let account: string | undefined;
    const status = await probeMcpServer(
      server,
      this.vault,
      fetcher,
      oauth,
      unnamed
        ? async (tools) => {
            account = await signedInAs(tools);
          }
        : undefined,
    );
    const wanted = app && account ? accountServerName(app, account) : undefined;
    if (!status.reachable || !wanted || wanted === name) return status;

    const renamed = await this.renameFree(name, wanted);
    return { ...status, name: renamed };
  }

  /**
   * The owner's new name for a server, which agents reach it by from their next runs. Refused
   * when another server holds it, rather than numbered: the owner chose that name.
   */
  async rename(from: string, input: unknown): Promise<McpServer[]> {
    const { name } = mcpRenameSchema.parse(input);

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const servers = await this.list(tx);
      if (!servers.some((server) => server.name === from)) {
        throw new GatewayError(404, 'MCP server not found');
      }
      if (name !== from && servers.some((server) => server.name === name)) {
        throw new GatewayError(409, `Another MCP server is already named ${name}`);
      }

      return this.move(servers, from, name, tx);
    });
  }

  /** Gives a server the first free name from \`to\`, and returns the name it took. */
  private async renameFree(from: string, to: string): Promise<string> {
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const servers = await this.list(tx);
      const taken = new Set(servers.map((server) => server.name).filter((item) => item !== from));
      let name = to;
      for (let count = 2; taken.has(name); count++) {
        name = `${to.slice(0, 30 - String(count).length - 1)}_${count}`;
      }
      await this.move(servers, from, name, tx);
      return name;
    });
  }

  /** Moves a server's secrets and sign-in to its new name, along with the server. */
  private async move(
    servers: McpServer[],
    from: string,
    name: string,
    tx: Queryable,
  ): Promise<McpServer[]> {
    if (name === from) return servers;

    const renamed = servers.map((server) => (server.name === from ? { ...server, name } : server));
    await this.vault.move(mcpSecret(from), mcpSecret(name), tx);
    await replaceMcpServers(tx, renamed, new Date(this.clock()));
    return renamed;
  }

  /**
   * Connects to a server the form holds but has not saved. Nothing is written: typed values
   * live only for this call, and a sign-in runs only for the saved server the draft still is —
   * its callback finds the server by name, so a sign-in started for anything else could never
   * finish.
   */
  async checkDraft(
    input: unknown,
    fetcher?: typeof globalThis.fetch,
    logins?: Pick<McpLogins, 'provider' | 'withAuthorization'>,
  ): Promise<McpStatus> {
    const { server } = mcpDraftCheckSchema.parse(input);
    const {
      stored: [draft],
      values,
      oauthSecrets,
    } = stripMcpValues([server]);

    if (!draft) throw new GatewayError(400, 'Invalid request');

    const typed = new Map([
      ...values.map(({ kind, name, value }) => [mcpValueSecret(draft.name, kind, name), value]),
      ...oauthSecrets.map(({ value }) => [mcpOauthClientSecretKey(draft.name), value]),
    ] as Array<[string, string]>);
    const reader: SecretReader = {
      read: async (owner) => typed.get(owner) ?? this.vault.read(owner),
    };
    const saved = (await this.list()).find((item) => item.name === draft.name);
    const signsIn =
      draft.auth === 'oauth' &&
      saved?.auth === 'oauth' &&
      saved.url === draft.url &&
      saved.oauthClientId === draft.oauthClientId;

    if (signsIn && logins) {
      return logins.withAuthorization(
        await probeMcpServer(draft, reader, fetcher, logins.provider),
      );
    }

    const status = await probeMcpServer(draft, reader, fetcher);

    // Without a sign-in to offer, the refusal an OAuth server answers with is the expected one.
    return draft.auth === 'oauth' && !status.reachable && /\(HTTP 401\)/.test(status.error ?? '')
      ? { ...status, error: 'the server asks for a sign-in, which opens once it is saved' }
      : status;
  }

  /** A header or variable the owner removed takes its secret with it. */
  private async discardStaleValues(
    server: McpServer,
    previous: McpServer[],
    tx: Queryable,
  ): Promise<void> {
    const before = previous.find((item) => item.name === server.name);

    if (!before) {
      return;
    }

    for (const kind of ['header', 'env'] as const) {
      const kept = new Set((kind === 'header' ? server.headers : server.env).map((v) => v.name));

      for (const value of kind === 'header' ? before.headers : before.env) {
        if (!kept.has(value.name)) {
          await this.vault.discard(mcpValueSecret(server.name, kind, value.name), tx);
        }
      }
    }

    // Dropping the OAuth client-secret field (or leaving OAuth) clears the vault entry.
    if (before.oauthClientSecret && !server.oauthClientSecret) {
      await this.vault.discard(mcpOauthClientSecretKey(server.name), tx);
    }
  }

  private async discardValues(server: McpServer, tx: Queryable): Promise<void> {
    // The legacy single-token entry and the sign-in share the server's own address.
    await this.vault.discard(mcpSecret(server.name), tx);
    await this.vault.discard(`${mcpSecret(server.name)}:oauth`, tx);
    await this.vault.discard(mcpOauthClientSecretKey(server.name), tx);

    for (const kind of ['header', 'env'] as const) {
      for (const value of kind === 'header' ? server.headers : server.env) {
        await this.vault.discard(mcpValueSecret(server.name, kind, value.name), tx);
      }
    }
  }
}
