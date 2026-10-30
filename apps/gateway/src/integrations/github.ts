import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import {
  type GitHubConnectedRepository,
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
/** An installation token lasts an hour; one is reused until this long before it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/**
 * What the GitHub App asks for, by GitHub App permission name (the REST `app-permissions`
 * schema). GitHub refuses the whole manifest for one name outside that list, so a name that
 * only exists for personal tokens does not belong here.
 */
const GITHUB_MCP_PERMISSIONS = {
  actions: 'write',
  checks: 'write',
  contents: 'write',
  deployments: 'write',
  discussions: 'write',
  environments: 'write',
  issues: 'write',
  metadata: 'read',
  packages: 'write',
  pages: 'write',
  pull_requests: 'write',
  secret_scanning_alerts: 'write',
  security_events: 'write',
  statuses: 'write',
  // Dependabot alerts.
  vulnerability_alerts: 'write',
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

type GitHubInstallation = GitHubIntegrationAccount & {
  installationId: number;
};

/** A panel path, `/settings/integrations[/github]`; the route's schema has checked it. */
export type GitHubReturnPath = string;

/**
 * Why connecting an account failed, as the panel is told in `?reason=` and the log records it.
 * GitHub has already installed the App by then, so this is the only trace of what went wrong.
 */
export type GitHubFailure =
  | 'denied'
  | 'incomplete'
  | 'expired'
  | 'authorization'
  | 'not-owner'
  | 'github'
  | 'save'
  | 'gateway';

export class GitHubConnectionFailure extends Error {
  constructor(
    readonly reason: GitHubFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Runs one step of a connection, so a failure names the step it happened in. */
async function step<T>(reason: GitHubFailure, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GitHubConnectionFailure) throw error;
    throw new GitHubConnectionFailure(
      reason,
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

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

/** What one attached GitHub MCP server reaches: an account's installation, or one repository. */
export type GitHubMcpAccess = { login: string; token: string; repository?: string };

/** What one git command against one repository borrows: a token for that repository alone. */
export type GitHubGitAccess = {
  /** `owner/name` as GitHub spells it. */
  repository: string;
  /** Where git reaches it over HTTPS, with no credential in it. */
  url: string;
  token: string;
  defaultBranch?: string;
};

/**
 * Global GitHub App installations, and the tokens that hand them to an agent's conversation:
 * scoped to the repository in a project bound to one, to the whole installation elsewhere.
 */
export class GitHubIntegrations {
  constructor(
    private readonly store: Store,
    private readonly vault: GatewayVault,
    private readonly publicUrl: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
    /** Where git clones from; a test points it at a local server. */
    private readonly gitOrigin = 'https://github.com',
  ) {}

  /** Keyed by installation and repository; `*` is a token for the whole installation. */
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

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
        // App names are unique across GitHub and public on the App's page: a random suffix tells
        // installations apart without naming the address this one is served at.
        name: `Jian - ${randomBytes(4).toString('hex')}`,
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

  /**
   * Records the installation GitHub just made, once the user GitHub authorized is shown to own
   * it. A failure is returned rather than thrown: GitHub already installed the App, so the caller
   * has to log why Jian did not record it, and still send the owner back.
   */
  async finish(
    state: string,
    code: string,
    installationId: number,
  ): Promise<{ location: string; failure?: GitHubConnectionFailure }> {
    const config = await this.requireConfig();
    const stateRow = await this.consumeState(state, 'installation');
    if (!stateRow) {
      return {
        location: await this.failedRedirect(state, 'expired'),
        failure: new GitHubConnectionFailure(
          'expired',
          'The authorization state is unknown, expired or was already used.',
        ),
      };
    }

    try {
      const userToken = await step('authorization', () => this.exchangeCode(config, code));
      const authorized = await step('github', () => this.authorizedInstallations(userToken));
      if (!authorized.some((installation) => installation.id === installationId)) {
        throw new GitHubConnectionFailure(
          'not-owner',
          `The authorized GitHub account cannot reach installation ${installationId}; it reaches ${authorized.length} installation(s) of this App.`,
        );
      }

      const installation = await step('github', () => this.getInstallation(config, installationId));
      const account = githubIntegrationAccountSchema.parse({
        installationId,
        accountId: installation.account.accountId,
        login: installation.account.login,
        type: installation.account.type,
        ...(installation.account.avatarUrl ? { avatarUrl: installation.account.avatarUrl } : {}),
        connectedAt: new Date(this.clock()).toISOString(),
        id: randomUUID(),
      });
      const [saved] = await step('save', () =>
        this.store.transaction('gateway', async (tx) =>
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
        ),
      );

      if (!saved) throw new GitHubConnectionFailure('save', 'The account was not saved.');
      return { location: `${stateRow.returnOrigin}?github=connected` };
    } catch (error) {
      const failure =
        error instanceof GitHubConnectionFailure
          ? error
          : new GitHubConnectionFailure(
              'gateway',
              error instanceof Error ? error.message : String(error),
              { cause: error },
            );

      return {
        location: `${stateRow.returnOrigin}?github=failed&reason=${failure.reason}`,
        failure,
      };
    }
  }

  async failedRedirect(state: string | undefined, reason?: GitHubFailure) {
    const row = state
      ? await this.store.transaction('gateway', async (tx) => {
          const [pending] = await tx
            .delete(githubInstallationStates)
            .where(eq(githubInstallationStates.hash, stateHash(state)))
            .returning({ returnOrigin: githubInstallationStates.returnOrigin });
          return pending;
        })
      : undefined;
    // Without its state there is no telling which page started it; Integrations is where both live.
    const origin =
      row?.returnOrigin ??
      (this.publicUrl
        ? new URL('/settings/integrations', this.publicUrl).toString()
        : '/settings/integrations');
    return `${origin}?github=failed${reason ? `&reason=${reason}` : ''}`;
  }

  /**
   * Every repository the App was granted, across every connected account, in one list: a
   * project picks a repository, and the account it comes through follows from it.
   */
  async allRepositories(): Promise<GitHubConnectedRepository[]> {
    const lists = await Promise.all(
      (await this.accounts()).map(async (account) =>
        (await this.repositories(account.id)).map((repository) => ({
          ...repository,
          accountId: account.id,
        })),
      ),
    );
    return lists.flat().sort((a, b) => a.fullName.localeCompare(b.fullName));
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

  /**
   * The GitHub one conversation reaches. A project bound to a repository gets a token for that
   * repository alone; any other conversation gets one per connected account, covering every
   * repository the owner granted the App there. Empty until an App is registered.
   */
  async mcpAccess(profileId: string, projectId?: string | null): Promise<GitHubMcpAccess[]> {
    if (!(await this.config())) return [];

    if (projectId) {
      const [project] = await this.store.db
        .select({ accountId: projects.githubAccountId, repositoryId: projects.githubRepositoryId })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.profileId, profileId)))
        .limit(1);

      if (project?.accountId && project.repositoryId) {
        const account = await this.account(project.accountId);
        const repository = await this.repository(project.accountId, project.repositoryId);
        const token = await this.installationToken(account.installationId, project.repositoryId);
        return [{ login: account.login, token, repository: repository.fullName }];
      }
    }

    return Promise.all(
      (await this.accounts()).map(async (account) => ({
        login: account.login,
        token: await this.installationToken(account.installationId),
      })),
    );
  }

  /**
   * A token git may use for one repository, under the reach `mcpAccess` gives the same
   * conversation: the project's repository alone in a project bound to one, any repository the
   * App was granted on a connected account elsewhere. The token covers that repository only,
   * whatever the installation reaches. Every refusal says what the owner can do about it.
   */
  async gitAccess(
    profileId: string,
    projectId: string | null | undefined,
    fullName: string,
  ): Promise<GitHubGitAccess> {
    if (!(await this.config())) {
      throw new GatewayError(
        503,
        'No GitHub App is connected to Jian. The owner can register one and connect an account under Integrations → GitHub; until then git reaches GitHub only with the SSH keys.',
      );
    }
    const wanted = fullName.toLowerCase();
    const bound = projectId ? await this.projectRepository(profileId, projectId) : undefined;

    if (bound) {
      if (bound.repository.fullName.toLowerCase() !== wanted) {
        throw new GatewayError(
          403,
          `This conversation belongs to a project bound to ${bound.repository.fullName}, and ${fullName} is outside it. Work on ${fullName} from a conversation outside the project.`,
        );
      }
      return this.lend(bound.installationId, bound.repository);
    }

    const accounts = await this.accounts();
    if (!accounts.length) {
      throw new GatewayError(
        503,
        'The GitHub App is registered, but no GitHub account is connected. The owner can connect one under Integrations → GitHub.',
      );
    }
    const owner = wanted.split('/')[0];
    const account = accounts.find((item) => item.login.toLowerCase() === owner);
    if (!account) {
      throw new GatewayError(
        404,
        `The Jian GitHub App is not installed on ${fullName.split('/')[0]}, so it cannot reach ${fullName}. The owner can install it on that account from Integrations → GitHub and grant it the repository.`,
      );
    }
    const repository = (await this.repositories(account.id)).find(
      (item) => item.fullName.toLowerCase() === wanted,
    );
    if (!repository) {
      throw new GatewayError(
        404,
        `The Jian GitHub App cannot reach ${fullName}: the repository does not exist, or the App was not granted it. The owner can grant it on GitHub, in the App's repository access for ${account.login}.`,
      );
    }
    return this.lend(account.installationId, repository);
  }

  private async lend(installationId: number, repository: GitHubRepository) {
    return {
      repository: repository.fullName,
      url: `${this.gitOrigin}/${repository.fullName}.git`,
      token: await this.installationToken(installationId, repository.id),
      ...(repository.defaultBranch ? { defaultBranch: repository.defaultBranch } : {}),
    };
  }

  /** The repository a project is bound to, with the installation it comes through. */
  private async projectRepository(profileId: string, projectId: string) {
    const [project] = await this.store.db
      .select({ accountId: projects.githubAccountId, repositoryId: projects.githubRepositoryId })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.profileId, profileId)))
      .limit(1);

    if (!project?.accountId || !project.repositoryId) return undefined;
    const account = await this.account(project.accountId);
    return {
      installationId: account.installationId,
      repository: await this.repository(project.accountId, project.repositoryId),
    };
  }

  /**
   * For polling a repository: the installation token of the connected account that owns it.
   * Undefined when none does, or when the token cannot be had, and the poll reads as a stranger
   * would: public repositories still answer, a private one says it is not found.
   */
  async tokenFor(owner: string): Promise<string | undefined> {
    if (!(await this.config())) return undefined;
    const account = (await this.accounts()).find(
      (item) => item.login.toLowerCase() === owner.toLowerCase(),
    );
    if (!account) return undefined;
    try {
      return await this.installationToken(account.installationId);
    } catch {
      return undefined;
    }
  }

  /**
   * A request to the API of a repository `owner` holds, as the installation on that account.
   * Undefined when no installation is on that account: nothing is ever asked with another
   * account's token. The token stays in here, and GitHub's answer comes back whatever its status,
   * so a caller can tell a repository the App cannot see (404) from a refusal (405, 409, 422).
   */
  async repoRequest(owner: string, path: string, init: RequestInit = {}) {
    const token = await this.tokenFor(owner);

    if (!token) return undefined;
    return this.fetcher(new URL(path, API), {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': API_VERSION,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
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
      .returning({
        id: githubInstallations.id,
        installationId: githubInstallations.installationId,
      });
    if (!row) throw new GatewayError(404, 'GitHub account not found.');
    for (const key of this.tokens.keys()) {
      if (key.startsWith(`${row.installationId}:`)) this.tokens.delete(key);
    }
    return { id: row.id };
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
    if (!response.ok) {
      throw new GatewayError(502, `GitHub answered ${response.status} to ${url.pathname}.`);
    }
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
    // GitHub answers a refused code with 200 and an `error`; that word is what says why.
    const token = (await response.json()) as {
      access_token?: unknown;
      error?: unknown;
      error_description?: unknown;
    };
    if (typeof token.access_token !== 'string' || !token.access_token) {
      const why =
        typeof token.error === 'string'
          ? ` (${token.error}${typeof token.error_description === 'string' ? `: ${token.error_description}` : ''})`
          : '';
      throw new GatewayError(400, `GitHub did not return an authorization token${why}.`);
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
    const key = `${installationId}:${repositoryId ?? '*'}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.clock()) return cached.token;

    const config = await this.requireConfig();
    const response = await this.githubFetch(
      new URL(`${API}/app/installations/${installationId}/access_tokens`),
      this.appToken(config),
      {
        method: 'POST',
        ...(repositoryId ? { body: JSON.stringify({ repository_ids: [repositoryId] }) } : {}),
      },
    );
    const issued = (await response.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof issued.token !== 'string' || !issued.token) {
      throw new GatewayError(502, 'GitHub did not issue an installation token.');
    }
    const expiresAt = typeof issued.expires_at === 'string' ? Date.parse(issued.expires_at) : NaN;
    // Without an expiry there is nothing safe to reuse it against.
    if (Number.isFinite(expiresAt)) this.tokens.set(key, { token: issued.token, expiresAt });
    return issued.token;
  }
}
