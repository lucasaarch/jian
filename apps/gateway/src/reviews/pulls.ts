import type { GitHubMergeable, GitHubPullFilter, GitHubPullRow } from '@jian/contracts';
import { z } from 'zod';

/**
 * One GitHub search per connected account, in GraphQL, so a page of pull requests comes with
 * its reviewers, checks and merge state in a single request instead of four per row.
 */

/** Pull requests read per account: GitHub's search returns them most recently updated first. */
export const PULLS_PER_ACCOUNT = 50;

export const PULLS_QUERY = `query($q: String!, $first: Int!) {
  search(query: $q, type: ISSUE, first: $first) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt updatedAt headRefName headRefOid
        reviewDecision mergeable mergeStateStatus
        author { login avatarUrl }
        repository { name owner { login } }
        labels(first: 10) { nodes { name color } }
        reviewRequests(first: 10) {
          nodes { requestedReviewer {
            ... on User { login avatarUrl }
            ... on Bot { login avatarUrl }
            ... on Mannequin { login avatarUrl }
            ... on Team { slug }
          } }
        }
        latestReviews(first: 10) { nodes { state author { login avatarUrl } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 1) {
          checkRunCountsByState { state count }
          statusContextCountsByState { state count }
        } } } } }
      }
    }
  }
}`;

/**
 * The search one account answers. `scope` is `user:<login>` or `repo:<owner/name>`; `q` is the
 * owner's own words, a GraphQL variable, so nothing in it reaches the query's text.
 */
export function searchQuery(
  scope: string,
  filter: GitHubPullFilter,
  q: string | undefined,
  me: string | undefined,
): string {
  const parts = ['is:pr', 'is:open', 'archived:false', 'sort:updated-desc', scope];
  if (filter === 'mine' && me) parts.push(`author:${me}`);
  // Waiting on someone: neither a draft nor already approved.
  if (filter === 'review') parts.push('draft:false', '-review:approved');
  const words = q?.replace(/\s+/g, ' ').trim();
  if (words) parts.push(words);
  return parts.join(' ');
}

const person = z.object({ login: z.string(), avatarUrl: z.string().optional() }).nullish();
const counts = z.array(z.object({ state: z.string(), count: z.number() })).nullish();

const nodeSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  reviewDecision: z.string().nullish(),
  mergeable: z.string().nullish(),
  mergeStateStatus: z.string().nullish(),
  author: person,
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
  labels: z
    .object({ nodes: z.array(z.object({ name: z.string(), color: z.string() }).nullish()) })
    .nullish(),
  reviewRequests: z
    .object({
      nodes: z.array(
        z
          .object({
            requestedReviewer: z
              .object({
                login: z.string().optional(),
                avatarUrl: z.string().optional(),
                slug: z.string().optional(),
              })
              .nullish(),
          })
          .nullish(),
      ),
    })
    .nullish(),
  latestReviews: z
    .object({ nodes: z.array(z.object({ state: z.string(), author: person }).nullish()) })
    .nullish(),
  commits: z
    .object({
      nodes: z.array(
        z
          .object({
            commit: z.object({
              statusCheckRollup: z
                .object({
                  contexts: z.object({
                    checkRunCountsByState: counts,
                    statusContextCountsByState: counts,
                  }),
                })
                .nullish(),
            }),
          })
          .nullish(),
      ),
    })
    .nullish(),
});

export const searchResponseSchema = z.object({
  data: z
    .object({
      search: z.object({
        issueCount: z.number(),
        // Anything that is not a pull request comes back as an empty object, and is skipped.
        nodes: z.array(z.unknown()),
      }),
    })
    .nullish(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED']);

function checksOf(node: z.infer<typeof nodeSchema>) {
  const contexts = node.commits?.nodes.at(-1)?.commit.statusCheckRollup?.contexts;
  if (!contexts) return undefined;
  const summary = { passing: 0, failing: 0, pending: 0 };
  for (const { state, count } of [
    ...(contexts.checkRunCountsByState ?? []),
    ...(contexts.statusContextCountsByState ?? []),
  ]) {
    if (PASSING.has(state)) summary.passing += count;
    else if (PENDING.has(state)) summary.pending += count;
    // Failure, error, timed out, cancelled, action required, stale, startup failure.
    else summary.failing += count;
  }
  return summary.passing + summary.failing + summary.pending ? summary : undefined;
}

/** GitHub's merge state, in the words the pull request drawer already uses. */
function mergeableOf(node: z.infer<typeof nodeSchema>): GitHubMergeable {
  if (node.mergeable === 'CONFLICTING' || node.mergeStateStatus === 'DIRTY') return 'conflicts';
  switch (node.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
    case 'UNSTABLE':
      return 'clean';
    case 'BEHIND':
      return 'behind';
    case 'BLOCKED':
    case 'DRAFT':
      return 'blocked';
    default:
      return 'unknown';
  }
}

const REVIEW_STATES = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
} as const;

const DECISIONS = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required',
} as const;

const avatar = (url: string | undefined) =>
  url && /^https:\/\//.test(url) ? { avatarUrl: url } : {};

function reviewersOf(node: z.infer<typeof nodeSchema>): GitHubPullRow['reviewers'] {
  const reviewers = new Map<string, GitHubPullRow['reviewers'][number]>();
  for (const review of node.latestReviews?.nodes ?? []) {
    const state = REVIEW_STATES[review?.state as keyof typeof REVIEW_STATES];
    if (!review?.author || !state) continue;
    reviewers.set(review.author.login, {
      login: review.author.login,
      ...avatar(review.author.avatarUrl),
      state,
    });
  }
  for (const request of node.reviewRequests?.nodes ?? []) {
    const reviewer = request?.requestedReviewer;
    const login = reviewer?.login ?? reviewer?.slug;
    if (!login) continue;
    // Asked again after reviewing: the new request is what is waiting.
    reviewers.set(login, { login, ...avatar(reviewer?.avatarUrl), state: 'requested' });
  }
  return [...reviewers.values()].slice(0, 20);
}

/** The rows one account's search answered; anything malformed is skipped, not fatal. */
export function pullRows(nodes: unknown[]): GitHubPullRow[] {
  const rows: GitHubPullRow[] = [];
  for (const raw of nodes) {
    const parsed = nodeSchema.safeParse(raw);
    if (!parsed.success) continue;
    const node = parsed.data;
    const checks = checksOf(node);
    const decision = DECISIONS[node.reviewDecision as keyof typeof DECISIONS];
    rows.push({
      owner: node.repository.owner.login,
      repo: node.repository.name,
      number: node.number,
      url: node.url,
      title: node.title.slice(0, 1000),
      draft: node.isDraft,
      ...(node.author
        ? { author: { login: node.author.login, ...avatar(node.author.avatarUrl) } }
        : {}),
      headRef: node.headRefName.slice(0, 255),
      headSha: node.headRefOid,
      labels: (node.labels?.nodes ?? [])
        .flatMap((label) => (label ? [{ name: label.name, color: label.color.slice(0, 6) }] : []))
        .slice(0, 10),
      reviewers: reviewersOf(node),
      ...(decision ? { reviewDecision: decision } : {}),
      ...(checks ? { checks } : {}),
      mergeable: mergeableOf(node),
      createdAt: new Date(node.createdAt).toISOString(),
      updatedAt: new Date(node.updatedAt).toISOString(),
    });
  }
  return rows;
}
