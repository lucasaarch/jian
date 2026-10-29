import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import {
  type GitHubIntegrationAccount,
  type GitHubRepository,
  githubIntegrationAccountSchema,
  githubRepositorySchema,
} from '@jian/contracts';
import { and, asc, eq, gt, lt } from 'drizzle-orm';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { GatewayVault } from '../security/gateway-vault.js';
import type { Store } from '../storage/database.js';
import { githubInstallationStates, githubInstallations, projects } from '../storage/schema.js';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const STATE_LIFETIME_MS = 10 * 60_000;
const PAGE_SIZE = 100;
const PAGE_LIMIT = 50;
const GITHUB_MCP_PERMISSIONS = {
  actions: 'write',
  checks: 'write',
  contents: 'write',
  dependabot_alerts: 'write',
  deployments: 'write',
  discussions: 'write',
  environments: 'write',
  issues: 'write',
  metadata: 'read',
  packages: 'write',
  pages: 'write',
  pull_requests: 'write',
  repository_advisories: 'write',
  secret_scanning_alerts: 'write',
  security_events: 'write',
  statuses: 'write',
  workflows: 'write',
} as const;

export type GitHubAppConfig = {
  appId: number;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  slug: string;
  name?: string;
  ownerLogin?: string;
  ownerType?: 'User' | 'Organization';
};

export type GitHubInstallation = GitHubIntegrationAccount & {
  installationId: number;
};

export type GitHubReturnPath =
  | '/integrations'
  | '/ui/integrations'
  | '/integrations/github'
  | '/ui/integrations/github';

const userInstallationsResponse = z.object({
  installations: z.array(z.object({ id: z.number().int().positive().safe() })),
});

const repositoriesResponse = {
  parse(value: unknown): GitHubRepository[] {
    if (
      !value ||
      typeof value !== 'object' ||
      !Array.isArray((value as { repositories?: unknown }).repositories)
    ) {
      throw new Error('GitHub returned an invalid repository list.');
    }
    return (value as { repositories: unknown[] }).repositories.map((value) => {
      if (!value || typeof value !== 'object') throw new Error('Invalid repository entry.');
      const repo = value as Record<string, unknown>;
      return githubRepositorySchema.parse({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        ownerLogin: (repo.owner as Record<string, unknown> | undefined)?.login,
        private: repo.private,
        htmlUrl: repo.html_url,
        cloneUrl: repo.clone_url,
        ...(typeof repo.default_branch === 'string' ? { defaultBranch: repo.default_branch } : {}),
        ...(typeof repo.description === 'string' ? { description: repo.description } : {}),
      });
    });
  },
};

function encode(value: object) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function stateHash(state: string) {
  return createHash('sha256').update(state).digest('hex');
}

function accountOf(row: typeof githubInstallations.$inferSelect): GitHubInstallation {
  return {
    id: row.id,
    accountId: row.accountId,
    login: row.login,
    type: row.type,
    ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
    connectedAt: row.connectedAt.toISOString(),
    installationId: row.installationId,
  };
}

/** Global GitHub App installations with project-scoped MCP access tokens. */
export class GitHubIntegrations {
  constructor(
    private readonly store: Store,
    private readonly vault: GatewayVault,
    private readonly publicUrl: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  async status() {
    const config = await this.config();
    let permissionsVerified = false;
    let missingPermissions = Object.keys(GITHUB_MCP_PERMISSIONS);
    if (config) {
      try {
        const response = await this.githubFetch(new URL(`${API}/app`), this.appToken(config));
        const app = z
          .object({ permissions: z.record(z.string(), z.enum(['read', 'write', 'admin'])) })
          .parse(await response.json());
        missingPermissions = Object.entries(GITHUB_MCP_PERMISSIONS)
          .filter(([permission, access]) =>
            access === 'write'
              ? !['write', 'admin'].includes(app.permissions[permission] ?? '')
              : !app.permissions[permission],
          )
          .map(([permission]) => permission);
        permissionsVerified = true;
      } catch {
        permissionsVerified = false;
      }
    }
    return {
      configured: Boolean(config),
      ...(config ? { permissionsVerified, missingPermissions } : {}),
      ...(config
        ? {
            app: {
              appId: config.appId,
              name: config.name ?? 'Jian GitHub App',
              slug: config.slug,
              ...(config.ownerLogin ? { ownerLogin: config.ownerLogin } : {}),
              ...(config.ownerType ? { ownerType: config.ownerType } : {}),
              url: `https://github.com/apps/${config.slug}`,
            },
          }
        : {}),
      ...(this.publicUrl
        ? { callbackUrl: new URL('/v1/integrations/github/callback', this.publicUrl).toString() }
        : {}),
      accounts: await this.accounts(),
    };
  }

  async registration(returnOrigin: string | undefined, returnPath: GitHubReturnPath) {
    if (!this.publicUrl)
      throw new GatewayError(503, 'Set JIAN_PUBLIC_URL before connecting GitHub.');
    if (await this.config())
      throw new GatewayError(409, 'A GitHub App is already registered for this Jian instance.');
    const origin = new URL(returnOrigin || this.publicUrl).origin;
    const allowedOrigin = new URL(this.publicUrl).origin;
    if (
      origin !== allowedOrigin &&
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)
    ) {
      throw new GatewayError(400, 'The integration must be started from this Jian panel.');
    }
    const state = randomBytes(32).toString('base64url');
    const now = this.clock();
    await this.store.transaction('gateway', async (tx) => {
      await tx
        .delete(githubInstallationStates)
        .where(lt(githubInstallationStates.expiresAt, new Date(now)));
      await tx.insert(githubInstallationStates).values({
        hash: stateHash(state),
        returnOrigin: `${origin}${returnPath}`,
        purpose: 'registration',
        expiresAt: new Date(now + STATE_LIFETIME_MS),
        createdAt: new Date(now),
      });
    });
    const callback = new URL(
      '/v1/integrations/github/manifest/callback',
      this.publicUrl,
    ).toString();
    return {
      state,
      action: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`,
      manifest: {
        name: `Jian - ${new URL(origin).host} - ${randomBytes(3).toString('hex')}`,
        url: origin,
        redirect_url: callback,
        callback_urls: [new URL('/v1/integrations/github/callback', this.publicUrl).toString()],
        setup_url: new URL('/v1/integrations/github/callback', this.publicUrl).toString(),
        setup_on_update: true,
        public: true,
        request_oauth_on_install: true,
        default_permissions: GITHUB_MCP_PERMISSIONS,
        default_events: [],
      },
    };
  }

  async registerFromManifest(state: string, code: string) {
    const stateRow = await this.consumeState(state, 'registration');
    if (!stateRow) throw new GatewayError(400, 'This GitHub App registration has expired.');
    try {
      const response = await this.fetcher(
        `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
        {
          method: 'POST',
          headers: { accept: 'application/vnd.github+json', 'x-github-api-version': API_VERSION },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw new GatewayError(502, `GitHub answered ${response.status}.`);
      const app = z
        .object({
          id: z.number().int().positive().safe(),
          slug: z.string().min(1),
          name: z.string().min(1).optional(),
          owner: z
            .object({ login: z.string().min(1), type: z.enum(['User', 'Organization']) })
            .optional(),
          client_id: z.string().min(1),
          client_secret: z.string().min(1),
          pem: z.string().min(1),
        })
        .parse(await response.json());
      await this.store.transaction('gateway', async (tx) => {
        if (await this.vault.read('github-app-config', tx)) {
          throw new GatewayError(409, 'A GitHub App is already registered for this Jian instance.');
        }
        await this.vault.put(
          'github-app-config',
          JSON.stringify({
            appId: app.id,
            slug: app.slug,
            name: app.name,
            ownerLogin: app.owner?.login,
            ownerType: app.owner?.type,
            clientId: app.client_id,
            clientSecret: app.client_secret,
            privateKey: app.pem,
          }),
          tx,
        );
      });
      return `${stateRow.returnOrigin}?github=registered`;
    } catch {
      return `${stateRow.returnOrigin}?github=failed`;
    }
  }

  async accounts(): Promise<GitHubIntegrationAccount[]> {
    const rows = await this.store.db
      .select()
      .from(githubInstallations)
      .orderBy(asc(githubInstallations.login));
    return rows.map(accountOf);
  }

  async start(returnOrigin: string | undefined, returnPath: GitHubReturnPath) {
    const config = await this.requireConfig();
    if (!this.publicUrl)
      throw new GatewayError(503, 'Set JIAN_PUBLIC_URL before connecting GitHub.');
    const origin = new URL(returnOrigin || this.publicUrl).origin;
    const publicOrigin = new URL(this.publicUrl).origin;
    const localDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
    if (origin !== publicOrigin && !localDevelopment) {
      throw new GatewayError(400, 'The integration must be started from this Jian panel.');
    }

    const state = randomBytes(32).toString('base64url');
    const now = this.clock();
    await this.store.transaction('gateway', async (tx) => {
      await tx
        .delete(githubInstallationStates)
        .where(lt(githubInstallationStates.expiresAt, new Date(now)));
      await tx.insert(githubInstallationStates).values({
        hash: stateHash(state),
        returnOrigin: `${origin}${returnPath}`,
        purpose: 'installation',
        expiresAt: new Date(now + STATE_LIFETIME_MS),
        createdAt: new Date(now),
      });
    });

    const url = new URL(`https://github.com/apps/${config.slug}/installations/new`);
    url.searchParams.set('state', state);
    return { url: url.toString() };
  }

  async finish(state: string, code: string, installationId: number) {
    const config = await this.requireConfig();
    const stateRow = await this.consumeState(state, 'installation');
    if (!stateRow) throw new GatewayError(400, 'This GitHub authorization has expired.');

    try {
      const userToken = await this.exchangeCode(config, code);
      const authorized = await this.authorizedInstallations(userToken);
      if (!authorized.some((installation) => installation.id === installationId)) {
        throw new GatewayError(
          403,
          'The authorized GitHub account does not own this installation.',
        );
      }

      const installation = await this.getInstallation(config, installationId);
      const account = githubIntegrationAccountSchema.parse({
        accountId: installation.account.accountId,
        login: installation.account.login,
        type: installation.account.type,
        ...(installation.account.avatarUrl ? { avatarUrl: installation.account.avatarUrl } : {}),
        connectedAt: new Date(this.clock()).toISOString(),
        id: randomUUID(),
      });
      const [saved] = await this.store.transaction('gateway', async (tx) =>
        tx
          .insert(githubInstallations)
          .values({
            id: account.id,
            installationId,
            accountId: account.accountId,
            login: account.login,
            type: account.type,
            avatarUrl: account.avatarUrl ?? null,
            connectedAt: new Date(this.clock()),
          })
          .onConflictDoUpdate({
            target: githubInstallations.installationId,
            set: {
              accountId: account.accountId,
              login: account.login,
              type: account.type,
              avatarUrl: account.avatarUrl ?? null,
            },
          })
          .returning(),
      );

      if (!saved) throw new GatewayError(500, 'GitHub account could not be saved.');
      return `${stateRow.returnOrigin}?github=connected`;
    } catch {
      return `${stateRow.returnOrigin}?github=failed`;
    }
  }

  async failedRedirect(state: string | undefined) {
    const row = state
      ? await this.store.transaction('gateway', async (tx) => {
          const [pending] = await tx
            .delete(githubInstallationStates)
            .where(eq(githubInstallationStates.hash, stateHash(state)))
            .returning({ returnOrigin: githubInstallationStates.returnOrigin });
          return pending;
        })
      : undefined;
    const origin =
      row?.returnOrigin ??
      (this.publicUrl ? new URL('/integrations', this.publicUrl).toString() : '/integrations');
    return `${origin}?github=failed`;
  }

  async repositories(accountId: string): Promise<GitHubRepository[]> {
    const account = await this.account(accountId);
    const token = await this.installationToken(account.installationId);
    const output: GitHubRepository[] = [];
    for (let page = 1; page <= PAGE_LIMIT; page += 1) {
      const url = new URL(`${API}/installation/repositories`);
      url.searchParams.set('per_page', String(PAGE_SIZE));
      url.searchParams.set('page', String(page));
      const response = await this.githubFetch(url, token);
      const repositories = repositoriesResponse.parse(await response.json());
      output.push(...repositories);
      if (repositories.length < PAGE_SIZE) return output;
    }
    return output;
  }

  /** Mints a one-hour token restricted to the repository bound to this profile's project. */
  async mcpAccess(profileId: string, projectId: string) {
    const [project] = await this.store.db
      .select({ accountId: projects.githubAccountId, repositoryId: projects.githubRepositoryId })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.profileId, profileId)))
      .limit(1);
    if (!project?.accountId || !project.repositoryId) return undefined;

    const account = await this.account(project.accountId);
    const repository = await this.repository(project.accountId, project.repositoryId);
    const token = await this.installationToken(account.installationId, project.repositoryId);
    return { token, repository: repository.fullName };
  }

  async repository(accountId: string, repositoryId: number) {
    const repository = (await this.repositories(accountId)).find(
      (item) => item.id === repositoryId,
    );
    if (!repository) throw new GatewayError(404, 'The selected repository is not available.');
    return repository;
  }

  async disconnect(accountId: string) {
    const [row] = await this.store.db
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, accountId))
      .returning({ id: githubInstallations.id });
    if (!row) throw new GatewayError(404, 'GitHub account not found.');
    return row;
  }

  private async account(id: string) {
    const [row] = await this.store.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.id, id))
      .limit(1);
    if (!row) throw new GatewayError(404, 'GitHub account not found.');
    return accountOf(row);
  }

  private async config(): Promise<GitHubAppConfig | undefined> {
    const value = await this.vault.read('github-app-config');
    if (!value) return undefined;
    try {
      return z
        .object({
          appId: z.number().int().positive(),
          slug: z.string(),
          clientId: z.string(),
          clientSecret: z.string(),
          privateKey: z.string(),
          name: z.string().optional(),
          ownerLogin: z.string().optional(),
          ownerType: z.enum(['User', 'Organization']).optional(),
        })
        .parse(JSON.parse(value));
    } catch {
      throw new GatewayError(500, 'Stored GitHub App credentials are invalid.');
    }
  }

  private async requireConfig() {
    const config = await this.config();
    if (!config) throw new GatewayError(503, 'Register a GitHub App from Integrations first.');
    return config;
  }

  private async consumeState(state: string, purpose: 'installation' | 'registration') {
    return this.store.transaction('gateway', async (tx) => {
      const [row] = await tx
        .delete(githubInstallationStates)
        .where(
          and(
            eq(githubInstallationStates.hash, stateHash(state)),
            eq(githubInstallationStates.purpose, purpose),
            gt(githubInstallationStates.expiresAt, new Date(this.clock())),
          ),
        )
        .returning({ returnOrigin: githubInstallationStates.returnOrigin });
      return row;
    });
  }

  private appToken(config: GitHubAppConfig) {
    const now = Math.floor(this.clock() / 1000);
    const header = encode({ alg: 'RS256', typ: 'JWT' });
    const payload = encode({ iat: now - 60, exp: now + 540, iss: config.appId });
    const content = `${header}.${payload}`;
    const key = createPrivateKey(config.privateKey.replace(/\\n/g, '\n'));
    return `${content}.${sign('RSA-SHA256', Buffer.from(content), key).toString('base64url')}`;
  }

  private async githubFetch(url: URL, token: string, init: RequestInit = {}) {
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': API_VERSION,
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new GatewayError(502, `GitHub answered ${response.status}.`);
    return response;
  }

  private async exchangeCode(config: GitHubAppConfig, code: string) {
    const response = await this.fetcher('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new GatewayError(502, `GitHub answered ${response.status}.`);
    const token = (await response.json()) as { access_token?: unknown };
    if (typeof token.access_token !== 'string' || !token.access_token) {
      throw new GatewayError(400, 'GitHub did not return an authorization token.');
    }
    return token.access_token;
  }

  private async authorizedInstallations(userToken: string) {
    const installations: Array<{ id: number }> = [];
    for (let page = 1; page <= PAGE_LIMIT; page += 1) {
      const url = new URL(`${API}/user/installations`);
      url.searchParams.set('per_page', String(PAGE_SIZE));
      url.searchParams.set('page', String(page));
      const response = await this.githubFetch(url, userToken);
      const listed = userInstallationsResponse.parse(await response.json()).installations;
      installations.push(...listed);
      if (listed.length < PAGE_SIZE) return installations;
    }
    return installations;
  }

  private async getInstallation(config: GitHubAppConfig, installationId: number) {
    const response = await this.githubFetch(
      new URL(`${API}/app/installations/${installationId}`),
      this.appToken(config),
    );
    const raw = (await response.json()) as {
      account?: { id?: unknown; login?: unknown; type?: unknown; avatar_url?: unknown };
    };
    const account = raw.account;
    if (
      !account ||
      typeof account.id !== 'number' ||
      !Number.isSafeInteger(account.id) ||
      account.id <= 0 ||
      typeof account.login !== 'string' ||
      !['User', 'Organization'].includes(String(account.type))
    ) {
      throw new GatewayError(502, 'GitHub returned an invalid installation account.');
    }
    return {
      account: {
        accountId: account.id,
        login: account.login,
        type: account.type as 'User' | 'Organization',
        ...(typeof account.avatar_url === 'string' ? { avatarUrl: account.avatar_url } : {}),
      },
    };
  }

  private async installationToken(installationId: number, repositoryId?: number) {
    const config = await this.requireConfig();
    const response = await this.githubFetch(
      new URL(`${API}/app/installations/${installationId}/access_tokens`),
      this.appToken(config),
      {
        method: 'POST',
        ...(repositoryId ? { body: JSON.stringify({ repository_ids: [repositoryId] }) } : {}),
      },
    );
    const token = (await response.json()) as { token?: unknown };
    if (typeof token.token !== 'string' || !token.token) {
      throw new GatewayError(502, 'GitHub did not issue an installation token.');
    }
    return token.token;
  }
}
