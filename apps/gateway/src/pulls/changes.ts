/**
 * What a look at a pull request found, and what changed since the one before. Pure: the reading
 * is in `look.ts`, the telling in `message.ts`.
 */

/** A check's outcome on the head, by GitHub's own words, or `pending` while it runs. */
export type CheckOutcome = string;

/** What the next look compares against. Only ids and outcomes: no one's words are kept. */
export type WatchState = {
  /** Set once the first look recorded where the pull request started. */
  started?: boolean;
  headSha?: string;
  headRef?: string;
  mergeable?: boolean | null;
  reviews?: number[];
  lineComments?: number[];
  comments?: number[];
  /** Each check on `headSha`, by name. */
  checks?: Record<string, CheckOutcome>;
  /** Whether the checks on `headSha` were last seen all passed. */
  checksPassed?: boolean;
  /** The ETag of each address last read, so an unchanged one costs nothing. */
  etags?: Record<string, string>;
};

type User = { login?: string; type?: string } | null | undefined;

export type PullPayload = {
  state?: string;
  merged?: boolean;
  mergeable?: boolean | null;
  html_url?: string;
  head?: { sha?: string; ref?: string };
};
export type ReviewPayload = {
  id: number;
  state?: string;
  body?: string | null;
  html_url?: string;
  user?: User;
};
export type CommentPayload = {
  id: number;
  body?: string | null;
  html_url?: string;
  user?: User;
  path?: string;
  line?: number | null;
  original_line?: number | null;
};
export type CheckPayload = {
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  details_url?: string;
  output?: { title?: string | null; summary?: string | null } | null;
};
export type CommitPayload = {
  sha: string;
  author?: User;
  committer?: User;
  commit?: { message?: string; author?: { name?: string } | null };
};

/**
 * What one look read. A part left undefined was not read, or GitHub said it had not changed
 * (304): it is compared as it was.
 */
export type Look = {
  pull: PullPayload;
  reviews?: ReviewPayload[];
  lineComments?: CommentPayload[];
  comments?: CommentPayload[];
  checks?: CheckPayload[];
  /** The pull request's commits, read only when its head moved. */
  commits?: CommitPayload[];
};

export type Change =
  | { kind: 'review'; author: string; state: string; body: string; url?: string }
  | {
      kind: 'comment';
      author: string;
      body: string;
      url?: string;
      path?: string;
      line?: number;
    }
  | { kind: 'check-failed'; name: string; conclusion: string; url?: string; summary?: string }
  | { kind: 'checks-passed'; count: number }
  | { kind: 'conflict' }
  | { kind: 'commits'; commits: { sha: string; author: string; title: string }[] }
  | { kind: 'merged' }
  | { kind: 'closed' };

/** Conclusions a failed check ends with; anything else that completed passed or did not count. */
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

/**
 * Whether GitHub's App wrote it: the agent's own review, comment or commit, which it already
 * knows of. `appLogin` is the App's bot, `<slug>[bot]`.
 */
const isApp = (user: User, appLogin: string | undefined) =>
  Boolean(appLogin && user?.login?.toLowerCase() === appLogin.toLowerCase());

const outcomeOf = (check: CheckPayload): CheckOutcome =>
  check.status === 'completed' ? (check.conclusion ?? 'neutral') : 'pending';

/**
 * The changes between `before` and `look`, and the state the next look compares against. The
 * first look records where the pull request starts and tells nothing: the agent just made it.
 */
export function compare(
  before: WatchState,
  look: Look,
  options: { appLogin?: string; ownShas: readonly string[] },
): { changes: Change[]; state: WatchState; ended: boolean } {
  const changes: Change[] = [];
  const first = !before.started;
  const headSha = look.pull.head?.sha ?? before.headSha;
  const headMoved = Boolean(before.headSha && headSha && headSha !== before.headSha);

  const seen = (ids: number[] | undefined) => new Set(ids ?? []);

  const reviewsSeen = seen(before.reviews);
  for (const review of look.reviews ?? []) {
    if (reviewsSeen.has(review.id) || first) continue;
    // A pending review is still being written; one with no words only holds its line comments,
    // which come as comments of their own.
    if (review.state === 'PENDING') continue;
    if (review.state === 'COMMENTED' && !review.body?.trim()) continue;
    if (isApp(review.user, options.appLogin)) continue;
    changes.push({
      kind: 'review',
      author: review.user?.login ?? 'someone',
      state: (review.state ?? 'COMMENTED').toLowerCase().replace(/_/g, ' '),
      body: review.body?.trim() ?? '',
      ...(review.html_url ? { url: review.html_url } : {}),
    });
  }

  for (const [list, saw] of [
    [look.lineComments, seen(before.lineComments)],
    [look.comments, seen(before.comments)],
  ] as const) {
    for (const comment of list ?? []) {
      if (saw.has(comment.id) || first || isApp(comment.user, options.appLogin)) continue;
      const line = comment.line ?? comment.original_line ?? undefined;
      changes.push({
        kind: 'comment',
        author: comment.user?.login ?? 'someone',
        body: comment.body?.trim() ?? '',
        ...(comment.html_url ? { url: comment.html_url } : {}),
        ...(comment.path ? { path: comment.path } : {}),
        ...(line ? { line } : {}),
      });
    }
  }

  // A new head starts its checks over: what failed on the last one says nothing of this one.
  const priorChecks = headMoved ? {} : (before.checks ?? {});
  const priorPassed = headMoved ? false : Boolean(before.checksPassed);
  let checks = priorChecks;
  let checksPassed = priorPassed;
  if (look.checks) {
    checks = {};
    for (const check of look.checks) {
      if (!check.name) continue;
      const outcome = outcomeOf(check);
      checks[check.name] = outcome;
      const failedNow = FAILED.has(outcome);
      const failedBefore = FAILED.has(priorChecks[check.name] ?? '');
      if (!first && failedNow && !failedBefore) {
        const summary = [check.output?.title, check.output?.summary]
          .filter((part): part is string => Boolean(part?.trim()))
          .join('\n');
        const url = check.html_url ?? check.details_url;
        changes.push({
          kind: 'check-failed',
          name: check.name,
          conclusion: outcome,
          ...(url ? { url } : {}),
          ...(summary ? { summary } : {}),
        });
      }
    }
    const outcomes = Object.values(checks);
    checksPassed =
      outcomes.length > 0 &&
      outcomes.every((outcome) => outcome !== 'pending' && !FAILED.has(outcome));
    if (!first && checksPassed && !priorPassed) {
      changes.push({ kind: 'checks-passed', count: outcomes.length });
    }
  }

  const mergeable = look.pull.mergeable === undefined ? before.mergeable : look.pull.mergeable;
  // GitHub says null while it works it out; only a settled answer counts.
  if (!first && before.mergeable === true && mergeable === false)
    changes.push({ kind: 'conflict' });

  if (!first && headMoved && headSha && !options.ownShas.includes(headSha)) {
    const fromOthers = newCommits(look.commits ?? [], before.headSha)
      .filter((commit) => !isApp(commit.author, options.appLogin))
      .filter((commit) => !isApp(commit.committer, options.appLogin))
      .map((commit) => ({
        sha: commit.sha.slice(0, 7),
        author: commit.author?.login ?? commit.commit?.author?.name ?? 'someone',
        title: (commit.commit?.message ?? '').split('\n')[0] ?? '',
      }));
    if (fromOthers.length) changes.push({ kind: 'commits', commits: fromOthers });
  }

  const ended = look.pull.state === 'closed';
  if (ended) changes.push(look.pull.merged ? { kind: 'merged' } : { kind: 'closed' });

  return {
    changes,
    ended,
    state: {
      started: true,
      ...(headSha ? { headSha } : {}),
      ...((look.pull.head?.ref ?? before.headRef)
        ? { headRef: look.pull.head?.ref ?? before.headRef }
        : {}),
      mergeable: mergeable ?? null,
      reviews: union(before.reviews, look.reviews),
      lineComments: union(before.lineComments, look.lineComments),
      comments: union(before.comments, look.comments),
      checks,
      checksPassed,
      etags: before.etags ?? {},
    },
  };
}

/** The commits after `oldHead`, oldest first; all of them when it is gone, as after a force push. */
function newCommits(commits: CommitPayload[], oldHead: string | undefined) {
  const at = oldHead ? commits.findIndex((commit) => commit.sha === oldHead) : -1;
  return at === -1 ? commits : commits.slice(at + 1);
}

const union = (ids: number[] | undefined, items: { id: number }[] | undefined) =>
  items ? [...new Set([...(ids ?? []), ...items.map((item) => item.id)])] : (ids ?? []);
