import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type GitHubAgentReview,
  type GitHubPullList,
  type GitHubPullRow,
  type GitHubReviewSettings,
  type GitHubReviewsStatus,
  githubPullListQuerySchema,
  githubReviewSettingsSchema,
  githubStartReviewInputSchema,
} from '@jian/contracts';
import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { stableUuid } from '../core/ids.js';
import type { GitHubIntegrations } from '../integrations/github.js';
import type { Profiles } from '../profiles/service.js';
import type { RunWriter } from '../runs/port.js';
import type { Sessions } from '../sessions/service.js';
import type { Store } from '../storage/database.js';
import { gatewaySettings, githubReviews } from '../storage/schema.js';
import { DEFAULT_REVIEW_INSTRUCTIONS, type ReviewRef, reviewBrief } from './brief.js';
import {
  PULLS_PER_ACCOUNT,
  PULLS_QUERY,
  pullRows,
  searchQuery,
  searchResponseSchema,
} from './pulls.js';

const SETTINGS_KEY = 'githubReviews';
const RECEIVED_KEY = 'githubWebhookReceivedAt';

/** Actions of a `pull_request` delivery that mean a pull request is newly up for review. */
const STARTS = new Set(['opened', 'reopened', 'ready_for_review']);

const deliverySchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number().int().positive(),
    draft: z.boolean().optional(),
    head: z.object({ sha: z.string().regex(/^[0-9a-f]{40,64}$/) }),
  }),
  repository: z.object({
    name: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    owner: z.object({ login: z.string().regex(/^[A-Za-z0-9-]{1,39}$/) }),
  }),
});

type GitHub = Pick<
  GitHubIntegrations,
  | 'accounts'
  | 'repoRequest'
  | 'webhookUrl'
  | 'webhookSecret'
  | 'appSettingsUrl'
  | 'configureWebhook'
>;

type Answer = { rows: GitHubPullRow[]; truncated: boolean } | { failed: string };

const fullName = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

/**
 * The pull requests of the connected GitHub accounts, and the reviews agents are asked for on
 * them: by the owner from the panel, or by GitHub's webhook when one is opened. Each review is a
 * chat of the reviewing agent, started on Auto, since nobody may be there to approve its steps.
 */
export class PullReviews {
  constructor(
    private readonly github: GitHub,
    private readonly store: Store,
    private readonly profiles: Pick<Profiles, 'profile'>,
    private readonly sessions: Pick<Sessions, 'scheduledChat'>,
    private readonly runs: Pick<RunWriter, 'submit'>,
    private readonly clock: Clock = Date.now,
  ) {}

  async list(query: unknown): Promise<GitHubPullList> {
    const { filter = 'open', repository, q } = githubPullListQuerySchema.parse(query);
    const accounts = await this.github.accounts();
    // The owner's own GitHub account: the one the App is installed on as a person.
    const me = accounts.find((account) => account.type === 'User')?.login;
    if (filter === 'mine' && !me) return { pulls: [], truncated: false, unreachable: [] };
    const wanted = repository?.split('/')[0]?.toLowerCase();
    const reached = accounts.filter((account) => !wanted || account.login.toLowerCase() === wanted);

    const answers = await Promise.all(
      reached.map(async (account): Promise<Answer> => {
        const scope = repository ? `repo:${repository}` : `user:${account.login}`;
        try {
          const response = await this.github.repoRequest(account.login, '/graphql', {
            method: 'POST',
            // mergeStateStatus is still behind this preview on some GitHub versions.
            headers: { accept: 'application/vnd.github.merge-info-preview+json' },
            body: JSON.stringify({
              query: PULLS_QUERY,
              variables: { q: searchQuery(scope, filter, q, me), first: PULLS_PER_ACCOUNT },
            }),
          });
          if (!response?.ok) throw new Error(`GitHub answered ${response?.status ?? 'nothing'}`);
          const body = searchResponseSchema.parse(await response.json());
          if (!body.data) throw new Error(body.errors?.[0]?.message ?? 'GitHub sent no data');
          const rows = pullRows(body.data.search.nodes);
          return { rows, truncated: body.data.search.issueCount > rows.length };
        } catch {
          // One account GitHub would not answer for leaves the others' pull requests listed.
          return { failed: account.login };
        }
      }),
    );

    const pulls = answers
      .flatMap((answer) => ('rows' in answer ? answer.rows : []))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const latest = await this.latestReviews(pulls.map((pull) => fullName(pull.owner, pull.repo)));

    return {
      pulls: pulls.map((pull) => {
        const review = latest.get(`${fullName(pull.owner, pull.repo)}#${pull.number}`);
        return review ? { ...pull, review } : pull;
      }),
      truncated: answers.some((answer) => 'truncated' in answer && answer.truncated),
      unreachable: answers.flatMap((answer) => ('failed' in answer ? [answer.failed] : [])),
    };
  }

  async status(): Promise<GitHubReviewsStatus> {
    const [settings, received, secret, appSettingsUrl] = await Promise.all([
      this.settings(),
      this.setting(RECEIVED_KEY),
      this.github.webhookSecret(),
      this.github.appSettingsUrl(),
    ]);
    const url = this.github.webhookUrl();
    return {
      settings,
      webhook: {
        configured: Boolean(secret),
        ...(url ? { url } : {}),
        ...(appSettingsUrl ? { appSettingsUrl } : {}),
        ...(typeof received === 'string' ? { receivedAt: received } : {}),
      },
    };
  }

  async save(input: unknown): Promise<GitHubReviewsStatus> {
    const settings = githubReviewSettingsSchema.parse(input);
    if (settings.profileId) await this.profiles.profile(settings.profileId);
    await this.write(SETTINGS_KEY, {
      ...settings,
      repositories: [...new Set(settings.repositories.map((name) => name.toLowerCase()))],
    });
    return this.status();
  }

  async setUpWebhook(): Promise<GitHubReviewsStatus> {
    await this.github.configureWebhook();
    return this.status();
  }

  /** A review the owner asked for, of the pull request's head as GitHub has it now. */
  async start(
    params: { owner: string; repo: string; number: number },
    input: unknown,
  ): Promise<GitHubAgentReview> {
    const { profileId } = githubStartReviewInputSchema.parse(input);
    await this.profiles.profile(profileId);
    const { owner, repo, number } = params;
    const response = await this.github.repoRequest(
      owner,
      `/repos/${owner}/${repo}/pulls/${number}`,
    );
    if (!response?.ok) {
      throw new GatewayError(
        404,
        `The Jian GitHub App cannot see ${owner}/${repo}#${number}. The owner can grant it the repository on GitHub.`,
      );
    }
    const pull = z.object({ head: z.object({ sha: z.string() }) }).parse(await response.json());
    const review = await this.begin(profileId, {
      owner,
      repo,
      number,
      headSha: pull.head.sha,
      trigger: 'manual',
    });
    if (!review) throw new GatewayError(409, 'This review was already started.');
    return review;
  }

  /**
   * A delivery of the App's webhook. Its signature is checked over the bytes GitHub sent, with
   * the secret this gateway holds, before anything in it is read. Only a pull request newly up
   * for review starts one, and only as the settings allow.
   */
  async receive(headers: Record<string, unknown>, body: Buffer): Promise<{ accepted: boolean }> {
    const secret = await this.github.webhookSecret();
    if (!secret) throw new GatewayError(404, 'No GitHub webhook is set up on this gateway.');
    const signature = String(headers['x-hub-signature-256'] ?? '');
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const supplied = Buffer.from(signature);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, Buffer.from(expected))) {
      throw new GatewayError(401, 'The webhook signature does not match.');
    }
    await this.write(RECEIVED_KEY, new Date(this.clock()).toISOString());

    if (headers['x-github-event'] !== 'pull_request') return { accepted: false };
    let parsed: z.infer<typeof deliverySchema>;
    try {
      parsed = deliverySchema.parse(JSON.parse(body.toString('utf8')));
    } catch {
      return { accepted: false };
    }
    if (!STARTS.has(parsed.action)) return { accepted: false };

    const settings = await this.settings();
    const repository = fullName(parsed.repository.owner.login, parsed.repository.name);
    if (!settings.auto || !settings.profileId) return { accepted: false };
    if (parsed.pull_request.draft && !settings.drafts) return { accepted: false };
    if (settings.repositories.length && !settings.repositories.includes(repository)) {
      return { accepted: false };
    }

    const review = await this.begin(settings.profileId, {
      owner: parsed.repository.owner.login,
      repo: parsed.repository.name,
      number: parsed.pull_request.number,
      headSha: parsed.pull_request.head.sha,
      trigger: 'auto',
    });
    return { accepted: Boolean(review) };
  }

  /**
   * Records the review, opens its chat and starts the agent. An automatic one already recorded
   * for this head commit answers undefined. A run that cannot start takes its record with it,
   * so GitHub's redelivery, or the owner asking again, can try once more.
   */
  private async begin(profileId: string, ref: ReviewRef) {
    const id = randomUUID();
    const [row] = await this.store.db
      .insert(githubReviews)
      .values({
        id,
        repository: fullName(ref.owner, ref.repo),
        number: ref.number,
        headSha: ref.headSha,
        profileId,
        sessionId: stableUuid(`github-review:${id}`),
        trigger: ref.trigger,
        createdAt: new Date(this.clock()),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return undefined;

    try {
      const settings = await this.settings();
      const chat = await this.sessions.scheduledChat(
        profileId,
        row.sessionId,
        `Review ${ref.owner}/${ref.repo}#${ref.number}`,
      );
      await this.runs.submit(profileId, chat.id, {
        text: reviewBrief(ref, settings.instructions),
        requestKey: `github-review:${id}`,
      });
    } catch (error) {
      await this.store.db.delete(githubReviews).where(eq(githubReviews.id, id));
      throw error;
    }
    return reviewOf(row);
  }

  /** The newest review of each pull request in these repositories. */
  private async latestReviews(repositories: string[]) {
    const latest = new Map<string, GitHubAgentReview>();
    if (!repositories.length) return latest;
    const rows = await this.store.db
      .select()
      .from(githubReviews)
      .where(inArray(githubReviews.repository, [...new Set(repositories)]))
      .orderBy(desc(githubReviews.createdAt));
    for (const row of rows) {
      const key = `${row.repository}#${row.number}`;
      if (!latest.has(key)) latest.set(key, reviewOf(row));
    }
    return latest;
  }

  private async settings(): Promise<GitHubReviewSettings> {
    const saved = githubReviewSettingsSchema.safeParse(await this.setting(SETTINGS_KEY));
    return saved.success
      ? saved.data
      : {
          instructions: DEFAULT_REVIEW_INSTRUCTIONS,
          auto: false,
          drafts: false,
          repositories: [],
        };
  }

  private async setting(key: string): Promise<unknown> {
    const [row] = await this.store.db
      .select({ value: gatewaySettings.value })
      .from(gatewaySettings)
      .where(eq(gatewaySettings.key, key))
      .limit(1);
    return row?.value;
  }

  private async write(key: string, value: unknown) {
    await this.store.db
      .insert(gatewaySettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: gatewaySettings.key,
        set: { value, updatedAt: new Date(this.clock()) },
      });
  }
}

function reviewOf(row: typeof githubReviews.$inferSelect): GitHubAgentReview {
  return {
    id: row.id,
    profileId: row.profileId,
    sessionId: row.sessionId,
    trigger: row.trigger,
    headSha: row.headSha,
    createdAt: row.createdAt.toISOString(),
  };
}
