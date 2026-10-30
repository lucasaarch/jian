import type {
  GitHubCheck,
  GitHubIssue,
  GitHubLinkSummary,
  GitHubMergeable,
  GitHubMergeMethod,
  GitHubPull,
} from '@jian/contracts';
import { z } from 'zod';
import { patchDiff } from '../agent/diff.js';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { Store } from '../storage/database.js';
import type { GitHubIntegrations } from './github.js';

/**
 * Pull requests and issues read and merged as the GitHub App's installation on the account that
 * owns the repository. A repository no installation can see answers the same as one that does
 * not exist, so a link never reveals more than the App was granted.
 */

/** How long a card's summary is reused: a message list asks for every link it shows. */
const LINK_TTL_MS = 30_000;
/** Summaries kept at once; the oldest goes first. */
const LINK_CACHE = 500;
const BODY_CHARS = 20_000;
const COMMENT_CHARS = 10_000;
const COMMENTS = 30;
const FILES = 100;
/** A patch past this is not parsed: GitHub already leaves out the largest ones. */
const PATCH_BYTES = 400_000;

const LINK =
  /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/(pull|issues)\/(\d{1,8})(?:[/?#].*)?$/;

const user = z.object({ login: z.string(), avatar_url: z.string().optional() }).nullish();

const pullResponse = z.object({
  html_url: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().nullish(),
  merged: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  user,
  base: z.object({ ref: z.string(), sha: z.string() }),
  head: z.object({ ref: z.string(), sha: z.string() }),
  body: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
  changed_files: z.number().nullish(),
  mergeable: z.boolean().nullish(),
  mergeable_state: z.string().nullish(),
  comments: z.number().nullish(),
});

const repoResponse = z.object({
  allow_merge_commit: z.boolean().optional(),
  allow_squash_merge: z.boolean().optional(),
  allow_rebase_merge: z.boolean().optional(),
});

const reviewsResponse = z.array(
  z.object({
    user,
    state: z.string(),
    submitted_at: z.string().nullish(),
    body: z.string().nullish(),
  }),
);

const checkRunsResponse = z.object({
  check_runs: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullish(),
      html_url: z.string().nullish(),
      details_url: z.string().nullish(),
      started_at: z.string().nullish(),
      completed_at: z.string().nullish(),
    }),
  ),
});

const statusResponse = z.object({
  statuses: z.array(
    z.object({
      context: z.string(),
      state: z.string(),
      target_url: z.string().nullish(),
      created_at: z.string().nullish(),
      updated_at: z.string().nullish(),
    }),
  ),
});

const filesResponse = z.array(
  z.object({
    filename: z.string(),
    status: z.string(),
    additions: z.number(),
    deletions: z.number(),
    patch: z.string().optional(),
  }),
);

const issueResponse = z.object({
  html_url: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  user,
  labels: z.array(
    z.union([z.string(), z.object({ name: z.string(), color: z.string().nullish() })]),
  ),
  assignees: z.array(z.object({ login: z.string(), avatar_url: z.string().optional() })).nullish(),
  body: z.string().nullish(),
  comments: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullish(),
  pull_request: z.object({}).loose().nullish(),
});

const commentsResponse = z.array(
  z.object({ user, body: z.string().nullish(), created_at: z.string() }),
);

const mergeResponse = z.object({ sha: z.string(), message: z.string().optional() });
const errorResponse = z.object({ message: z.string() });

type Ref = { owner: string; repo: string; number: number };
type Summary = Exclude<GitHubLinkSummary, { reachable: false }>;
type CachedSummary = Omit<Summary, 'url'> | { reachable: false };

const clip = (text: string | null | undefined, max: number) => {
  const value = text ?? '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const person = (value: z.infer<typeof user>) =>
  value
    ? {
        login: clip(value.login, 100),
        ...(value.avatar_url?.startsWith('https://') ? { avatarUrl: value.avatar_url } : {}),
      }
    : undefined;

/** A timestamp as the contract writes it, or nothing when GitHub sent none it can parse. */
const time = (value: string | null | undefined) => {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
};

const https = (value: string | null | undefined) =>
  value?.startsWith('https://') && value.length <= 1000 ? value : undefined;

/**
 * GitHub's two answers to "can this merge" made into one. `mergeable` is null while GitHub is
 * still computing it after a push; `mergeable_state` names the reason when it can't merge.
 */
export function mergeableOf(
  mergeable: boolean | null | undefined,
  state: string | null | undefined,
): GitHubMergeable {
  if (mergeable === null || mergeable === undefined) return 'unknown';
  if (state === 'dirty') return 'conflicts';
  if (state === 'blocked' || state === 'draft') return 'blocked';
  if (state === 'behind') return 'behind';
  if (state === 'clean' || state === 'unstable' || state === 'has_hooks') return 'clean';
  if (state === 'unknown') return 'unknown';
  return mergeable ? 'clean' : 'conflicts';
}

const PASSING = new Set(['success', 'neutral', 'skipped']);

function summarize(checks: GitHubCheck[]) {
  const summary = { passing: 0, failing: 0, pending: 0 };

  for (const check of checks) {
    if (check.status !== 'completed') summary.pending += 1;
    else if (PASSING.has(check.conclusion ?? '')) summary.passing += 1;
    else summary.failing += 1;
  }
  return summary;
}

/** A link to a pull request or an issue on github.com, or undefined for any other link. */
export function githubLink(url: string): (Ref & { kind: 'pull' | 'issue' }) | undefined {
  const match = LINK.exec(url);

  if (!match) return undefined;
  return {
    owner: match[1] as string,
    repo: match[2] as string,
    kind: match[3] === 'pull' ? 'pull' : 'issue',
    number: Number(match[4]),
  };
}

/**
 * What the agent is asked when the owner presses Fix merge conflicts. Its own words would be
 * the owner's; these are the gateway's, read by the agent and kept out of the conversation.
 */
export function conflictsBrief(ref: Ref) {
  const url = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;

  return [
    `The owner asked you to resolve the merge conflicts in ${url}.`,
    'Bring its base branch into its branch, settle each conflict so both sides keep what they meant,',
    'run the checks that cover what you touched, and push the branch.',
    'Then say in a few lines what conflicted and how you settled it.',
  ].join(' ');
}

const keyOf = (ref: Ref) => `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();

export class GitHubItems {
  private readonly summaries = new Map<string, { at: number; value: CachedSummary }>();
  /**
   * Pull requests this gateway merged. GitHub's reads lag its writes: just after a merge it can
   * still answer open, and that answer would then be cached as the card's for half a minute.
   * A merge never comes undone, so what this gateway did wins over a read that has not caught up.
   */
  private readonly merged = new Set<string>();

  constructor(
    private readonly github: Pick<GitHubIntegrations, 'repoRequest'>,
    private readonly store: Store,
    private readonly clock: Clock = Date.now,
  ) {}

  async pull(ref: Ref): Promise<GitHubPull> {
    const base = `/repos/${ref.owner}/${ref.repo}`;
    const pull = await this.read(ref, `${base}/pulls/${ref.number}`, pullResponse);
    const sha = pull.head.sha;
    const [repo, reviews, checks, files, comments] = await Promise.all([
      this.optional(ref, base, repoResponse),
      this.optional(ref, `${base}/pulls/${ref.number}/reviews?per_page=100`, reviewsResponse),
      this.checks(ref, sha),
      this.optional(ref, `${base}/pulls/${ref.number}/files?per_page=${FILES}`, filesResponse),
      // A pull request's conversation is its issue's.
      pull.comments
        ? this.lastComments(ref, `${base}/issues/${ref.number}`, pull.comments)
        : Promise.resolve([]),
    ]);
    const latest = new Map<string, z.infer<typeof reviewsResponse>[number]>();

    // GitHub lists reviews oldest first; each reviewer's last one is where they stand.
    for (const review of reviews ?? []) {
      if (review.user && review.state !== 'PENDING') latest.set(review.user.login, review);
    }
    const standing = [...latest.values()].reverse().map((review) => ({
      reviewer: person(review.user) as { login: string },
      state: reviewState(review.state),
      ...(time(review.submitted_at) ? { submittedAt: time(review.submitted_at) } : {}),
      ...(review.body?.trim() ? { body: clip(review.body, COMMENT_CHARS) } : {}),
    }));
    const changedFiles = pull.changed_files ?? files?.length ?? 0;
    const read: GitHubPull = {
      ...ref,
      url: pull.html_url,
      title: clip(pull.title, 1000),
      state: pull.merged || this.merged.has(keyOf(ref)) ? 'merged' : pull.state,
      draft: pull.draft ?? false,
      ...(person(pull.user) ? { author: person(pull.user) } : {}),
      base: { ref: clip(pull.base.ref, 255), sha: pull.base.sha },
      head: { ref: clip(pull.head.ref, 255), sha },
      body: clip(pull.body, BODY_CHARS),
      createdAt: time(pull.created_at) ?? new Date(0).toISOString(),
      updatedAt: time(pull.updated_at) ?? new Date(0).toISOString(),
      ...(time(pull.merged_at) ? { mergedAt: time(pull.merged_at) } : {}),
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      changedFiles,
      mergeable: mergeableOf(pull.mergeable, pull.mergeable_state),
      mergeMethods: mergeMethods(repo),
      reviews: {
        approved: standing.filter((review) => review.state === 'approved').length,
        changesRequested: standing.filter((review) => review.state === 'changes_requested').length,
        commented: standing.filter((review) => review.state === 'commented').length,
        latest: standing.slice(0, 50),
      },
      checks: { summary: summarize(checks), runs: checks.slice(0, 200) },
      files: (files ?? []).slice(0, FILES).map((file) => {
        const diff =
          file.patch && Buffer.byteLength(file.patch) <= PATCH_BYTES
            ? patchDiff(file.filename, file.patch, file.status === 'added')
            : undefined;

        return {
          path: clip(file.filename, 4096),
          status: clip(file.status, 20),
          additions: file.additions,
          deletions: file.deletions,
          ...(diff ? { diff } : {}),
        };
      }),
      ...(changedFiles > FILES ? { filesTruncated: true } : {}),
      comments: comments.map((comment) => ({
        ...(person(comment.user) ? { author: person(comment.user) } : {}),
        body: clip(comment.body, COMMENT_CHARS),
        createdAt: time(comment.created_at) ?? new Date(0).toISOString(),
      })),
    };

    // What the drawer just read is the newest word on it: the cards in the conversation read
    // the same, instead of a summary from before.
    this.keep(keyOf(ref), {
      reachable: true,
      kind: 'pull',
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      title: read.title,
      state: read.state,
      draft: read.draft,
      checks: read.checks.summary,
      mergeable: read.mergeable,
    });
    return read;
  }

  async issue(ref: Ref): Promise<GitHubIssue> {
    const base = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
    const issue = await this.read(ref, base, issueResponse);
    const comments = issue.comments ? await this.lastComments(ref, base, issue.comments) : [];

    return {
      ...ref,
      kind: issue.pull_request ? 'pull' : 'issue',
      url: issue.html_url,
      title: clip(issue.title, 1000),
      state: issue.state,
      ...(person(issue.user) ? { author: person(issue.user) } : {}),
      labels: issue.labels
        .slice(0, 50)
        .map((label) =>
          typeof label === 'string'
            ? { name: clip(label, 100), color: '' }
            : { name: clip(label.name, 100), color: (label.color ?? '').slice(0, 6) },
        ),
      assignees: (issue.assignees ?? [])
        .slice(0, 20)
        .map((assignee) => person(assignee) as { login: string }),
      body: clip(issue.body, BODY_CHARS),
      comments: comments.map((comment) => ({
        ...(person(comment.user) ? { author: person(comment.user) } : {}),
        body: clip(comment.body, COMMENT_CHARS),
        createdAt: time(comment.created_at) ?? new Date(0).toISOString(),
      })),
      createdAt: time(issue.created_at) ?? new Date(0).toISOString(),
      updatedAt: time(issue.updated_at) ?? new Date(0).toISOString(),
      ...(time(issue.closed_at) ? { closedAt: time(issue.closed_at) } : {}),
    };
  }

  /** One summary per link, in order. A link the App cannot see, or that failed, is unreachable. */
  async links(urls: string[]): Promise<GitHubLinkSummary[]> {
    return Promise.all(
      urls.map(async (url) => {
        const ref = githubLink(url);

        if (!ref) return { url, reachable: false as const };
        const summary = await this.summary(ref);

        return summary.reachable ? { ...summary, url } : { url, reachable: false as const };
      }),
    );
  }

  async merge(
    ref: Ref,
    input: { method: GitHubMergeMethod; expectedHeadSha: string; profileId?: string },
    log: (message: string, error: unknown) => void,
  ) {
    const response = await this.request(
      ref,
      `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/merge`,
      {
        method: 'PUT',
        body: JSON.stringify({ merge_method: input.method, sha: input.expectedHeadSha }),
      },
    );

    // 405: not mergeable. 409: the head moved past the sha. 422 and 403: a rule refused it.
    if ([403, 405, 409, 422].includes(response.status)) {
      throw new GatewayError(409, await refusal(response));
    }
    if (!response.ok) throw new GatewayError(502, `GitHub answered ${response.status} to a merge.`);

    const merged = mergeResponse.parse(await response.json());

    this.remember(ref);
    if (input.profileId) {
      const profileId = input.profileId;

      // The merge already happened on GitHub; a feed that cannot take the event does not undo it.
      await this.store
        .transaction(profileId, (tx) =>
          recordEvent(tx, this.clock, profileId, 'github.pull.merged', {
            ...ref,
            method: input.method,
            sha: merged.sha,
          }),
        )
        .catch((error: unknown) => log('The merge event was not recorded.', error));
    }

    return {
      merged: true as const,
      sha: merged.sha.slice(0, 64),
      message: clip(merged.message ?? 'Pull request merged.', 500),
    };
  }

  private async summary(ref: Ref & { kind: 'pull' | 'issue' }): Promise<CachedSummary> {
    const key = keyOf(ref);
    const cached = this.summaries.get(key);
    const now = this.clock();

    if (cached && now - cached.at < LINK_TTL_MS) return cached.value;

    let value: CachedSummary;

    try {
      value = await this.lookup(ref);
      if (value.reachable && this.merged.has(key)) value = { ...value, state: 'merged' };
    } catch (error) {
      // Not found and not granted read the same and are kept; a passing failure is asked again.
      if (!(error instanceof GatewayError && error.statusCode === 404)) {
        return { reachable: false };
      }
      value = { reachable: false };
    }

    this.keep(key, value);
    return value;
  }

  /** The newest summary of an item, kept for the cards; the oldest goes once there are too many. */
  private keep(key: string, value: CachedSummary) {
    this.summaries.delete(key);
    this.summaries.set(key, { at: this.clock(), value });
    if (this.summaries.size > LINK_CACHE) {
      const oldest = this.summaries.keys().next().value;
      if (oldest !== undefined) this.summaries.delete(oldest);
    }
  }

  private async lookup(ref: Ref & { kind: 'pull' | 'issue' }): Promise<CachedSummary> {
    const base = `/repos/${ref.owner}/${ref.repo}`;

    if (ref.kind === 'issue') {
      const issue = await this.read(ref, `${base}/issues/${ref.number}`, issueResponse);

      if (!issue.pull_request) {
        return {
          reachable: true,
          kind: 'issue',
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
          title: clip(issue.title, 1000),
          state: issue.state,
        };
      }
    }

    const pull = await this.read(ref, `${base}/pulls/${ref.number}`, pullResponse);
    const checks = await this.checks(ref, pull.head.sha);

    return {
      reachable: true,
      kind: 'pull',
      owner: ref.owner,
      repo: ref.repo,
      number: ref.number,
      title: clip(pull.title, 1000),
      state: pull.merged ? 'merged' : pull.state,
      draft: pull.draft ?? false,
      checks: summarize(checks),
      mergeable: mergeableOf(pull.mergeable, pull.mergeable_state),
    };
  }

  /** A merge this gateway made: the next read of the card asks again and reads it as merged. */
  private remember(ref: Ref) {
    const key = keyOf(ref);

    this.summaries.delete(key);
    this.merged.add(key);
    if (this.merged.size > LINK_CACHE) {
      const oldest = this.merged.values().next().value;
      if (oldest !== undefined) this.merged.delete(oldest);
    }
  }

  /** Check runs and commit statuses of one commit, as one list: CI reports through either. */
  private async checks(ref: Ref, sha: string): Promise<GitHubCheck[]> {
    const base = `/repos/${ref.owner}/${ref.repo}/commits/${sha}`;
    const [runs, statuses] = await Promise.all([
      this.optional(ref, `${base}/check-runs?per_page=100`, checkRunsResponse),
      this.optional(ref, `${base}/status`, statusResponse),
    ]);
    const latest = new Map<string, z.infer<typeof checkRunsResponse>['check_runs'][number]>();

    // A re-run adds a check run under the same name; the newest one is the result.
    for (const run of runs?.check_runs ?? []) {
      const seen = latest.get(run.name);
      if (!seen || seen.id < run.id) latest.set(run.name, run);
    }

    return [
      ...[...latest.values()].map((run) => {
        const status = (['queued', 'in_progress', 'completed'] as const).find(
          (value) => value === run.status,
        );
        const url = https(run.html_url) ?? https(run.details_url);
        return {
          name: clip(run.name, 300) || 'Check',
          status: status ?? 'queued',
          ...(run.conclusion ? { conclusion: clip(run.conclusion, 40) } : {}),
          ...(url ? { url } : {}),
          ...(time(run.started_at) ? { startedAt: time(run.started_at) } : {}),
          ...(time(run.completed_at) ? { completedAt: time(run.completed_at) } : {}),
        };
      }),
      ...(statuses?.statuses ?? []).map((status) => {
        const url = https(status.target_url);
        const done = status.state !== 'pending';
        return {
          name: clip(status.context, 300) || 'Status',
          status: done ? ('completed' as const) : ('in_progress' as const),
          ...(done ? { conclusion: status.state === 'success' ? 'success' : 'failure' } : {}),
          ...(url ? { url } : {}),
          ...(time(status.created_at) ? { startedAt: time(status.created_at) } : {}),
          ...(done && time(status.updated_at) ? { completedAt: time(status.updated_at) } : {}),
        };
      }),
    ];
  }

  /** The last comments of an issue, oldest first: GitHub pages them from the first one. */
  private async lastComments(ref: Ref, base: string, count: number) {
    const last = Math.ceil(count / COMMENTS);
    const pages = await Promise.all(
      (last > 1 ? [last - 1, last] : [last]).map((page) =>
        this.optional(ref, `${base}/comments?per_page=${COMMENTS}&page=${page}`, commentsResponse),
      ),
    );

    return pages.flatMap((page) => page ?? []).slice(-COMMENTS);
  }

  /** The one read the answer depends on: an unseen repository is a 404, anything else a 502. */
  private async read<T>(ref: Ref, path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.request(ref, path);

    if (response.status === 404 || response.status === 403) throw unreachable(ref);
    if (!response.ok) {
      throw new GatewayError(502, `GitHub answered ${response.status} for ${describe(ref)}.`);
    }
    const parsed = schema.safeParse(await response.json());

    if (!parsed.success)
      throw new GatewayError(502, `GitHub sent an unexpected answer for ${describe(ref)}.`);
    return parsed.data;
  }

  /** A part of the view it can go without: reviews, checks, files. Missing reads as none. */
  private async optional<T>(ref: Ref, path: string, schema: z.ZodType<T>): Promise<T | undefined> {
    try {
      const response = await this.request(ref, path);
      if (!response.ok) return undefined;
      const parsed = schema.safeParse(await response.json());
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private async request(ref: Ref, path: string, init?: RequestInit) {
    let response: Response | undefined;

    try {
      response = await this.github.repoRequest(ref.owner, path, init);
    } catch {
      throw new GatewayError(502, `GitHub could not be reached for ${describe(ref)}.`);
    }
    if (!response) throw unreachable(ref);
    return response;
  }
}

const describe = (ref: Ref) => `${ref.owner}/${ref.repo}#${ref.number}`;

const unreachable = (ref: Ref) =>
  new GatewayError(404, `No connected GitHub installation can see ${describe(ref)}.`);

function reviewState(state: string) {
  const known = {
    APPROVED: 'approved',
    CHANGES_REQUESTED: 'changes_requested',
    COMMENTED: 'commented',
    DISMISSED: 'dismissed',
  } as const;

  return known[state as keyof typeof known] ?? 'pending';
}

/** The methods the repository allows. A token that cannot read the settings is offered all. */
function mergeMethods(repo: z.infer<typeof repoResponse> | undefined): GitHubMergeMethod[] {
  const allowed: GitHubMergeMethod[] = [];

  if (repo?.allow_merge_commit !== false) allowed.push('merge');
  if (repo?.allow_squash_merge !== false) allowed.push('squash');
  if (repo?.allow_rebase_merge !== false) allowed.push('rebase');
  return allowed;
}

/** GitHub's own reason for refusing, which says what to fix, cut to a line. */
async function refusal(response: Response) {
  const parsed = errorResponse.safeParse(await response.json().catch(() => undefined));

  return clip(parsed.success ? parsed.data.message : 'GitHub refused the merge.', 300);
}
