import { z } from 'zod';
import { codeDiffSchema } from './records.js';

/**
 * Pull requests and issues the agent links to, read through the installation's GitHub App. Only
 * a repository the App was granted answers; anything else reads as unreachable, never as a
 * stranger's view of a private repository.
 */

/** GitHub's own rules for an owner and a repository name, so a path segment is never more. */
export const githubOwnerSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
export const githubRepoSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);

export const githubItemParamsSchema = z.strictObject({
  owner: githubOwnerSchema,
  repo: githubRepoSchema,
  number: z.coerce.number().int().positive().max(10_000_000),
});

const githubUserSchema = z.strictObject({
  login: z.string().min(1).max(100),
  avatarUrl: z.url().max(500).optional(),
});

/**
 * Whether a pull request can merge now. `unknown` while GitHub is still working it out, which
 * it does on the first read after a push: the panel asks again shortly.
 */
export const githubMergeableSchema = z.enum(['clean', 'conflicts', 'blocked', 'behind', 'unknown']);
export const githubMergeMethodSchema = z.enum(['merge', 'squash', 'rebase']);

/** A check run or a commit status, read as one list. */
export const githubCheckSchema = z.strictObject({
  name: z.string().min(1).max(300),
  status: z.enum(['queued', 'in_progress', 'completed']),
  /** Set once completed: success, failure, neutral, cancelled, skipped, timed_out, … */
  conclusion: z.string().max(40).optional(),
  url: z.url().max(1000).optional(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
});

/** How a pull request's checks stand, counted. */
export const githubChecksSummarySchema = z.strictObject({
  passing: z.number().int().nonnegative(),
  failing: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
});

export const githubReviewSchema = z.strictObject({
  reviewer: githubUserSchema,
  state: z.enum(['approved', 'changes_requested', 'commented', 'dismissed', 'pending']),
  submittedAt: z.iso.datetime().optional(),
  /** What the reviewer wrote with it, Markdown; absent when they only chose a verdict. */
  body: z.string().max(10_000).optional(),
});

/** A comment in an issue's or a pull request's conversation. */
export const githubCommentSchema = z.strictObject({
  author: githubUserSchema.optional(),
  body: z.string().max(10_000),
  createdAt: z.iso.datetime(),
});

export const githubPullFileSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  status: z.string().max(20),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** Absent when GitHub gives no patch: a binary file, or one too large to show. */
  diff: codeDiffSchema.optional(),
});

export const githubPullSchema = z.strictObject({
  owner: githubOwnerSchema,
  repo: githubRepoSchema,
  number: z.number().int().positive(),
  url: z.url().max(1000),
  title: z.string().max(1000),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  author: githubUserSchema.optional(),
  base: z.strictObject({ ref: z.string().max(255), sha: z.string().max(64) }),
  head: z.strictObject({ ref: z.string().max(255), sha: z.string().max(64) }),
  /** Markdown, cut to a length a drawer reads. */
  body: z.string().max(20_000),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  mergedAt: z.iso.datetime().optional(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  mergeable: githubMergeableSchema,
  mergeMethods: z.array(githubMergeMethodSchema).max(3),
  reviews: z.strictObject({
    approved: z.number().int().nonnegative(),
    changesRequested: z.number().int().nonnegative(),
    commented: z.number().int().nonnegative(),
    /** The latest review of each reviewer, newest first. */
    latest: z.array(githubReviewSchema).max(50),
  }),
  checks: z.strictObject({
    summary: githubChecksSummarySchema,
    runs: z.array(githubCheckSchema).max(200),
  }),
  files: z.array(githubPullFileSchema).max(100),
  /** The pull request changes more files than are listed. */
  filesTruncated: z.boolean().optional(),
  /** The last comments of its conversation, oldest first. */
  comments: z.array(githubCommentSchema).max(30),
});

export const githubIssueSchema = z.strictObject({
  owner: githubOwnerSchema,
  repo: githubRepoSchema,
  number: z.number().int().positive(),
  /** An issue number GitHub answers as a pull request: the panel shows that view instead. */
  kind: z.enum(['issue', 'pull']),
  url: z.url().max(1000),
  title: z.string().max(1000),
  state: z.enum(['open', 'closed']),
  author: githubUserSchema.optional(),
  labels: z.array(z.strictObject({ name: z.string().max(100), color: z.string().max(6) })).max(50),
  assignees: z.array(githubUserSchema).max(20),
  body: z.string().max(20_000),
  comments: z.array(githubCommentSchema).max(30),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().optional(),
});

/** Links to look up for the cards in a conversation, at most a screenful at a time. */
export const githubLinksInputSchema = z.strictObject({
  urls: z.array(z.url().max(1000)).min(1).max(20),
});

/** What a card shows about one link, or that the App cannot see it. */
export const githubLinkSummarySchema = z.union([
  z.strictObject({
    url: z.string().max(1000),
    reachable: z.literal(true),
    kind: z.enum(['pull', 'issue']),
    owner: githubOwnerSchema,
    repo: githubRepoSchema,
    number: z.number().int().positive(),
    title: z.string().max(1000),
    state: z.enum(['open', 'closed', 'merged']),
    draft: z.boolean().optional(),
    checks: githubChecksSummarySchema.optional(),
    mergeable: githubMergeableSchema.optional(),
  }),
  z.strictObject({ url: z.string().max(1000), reachable: z.literal(false) }),
]);

export const githubMergeInputSchema = z.strictObject({
  method: githubMergeMethodSchema,
  /** The head the owner saw: a branch that moved since is not merged blind. */
  expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** The agent whose conversation the merge was made from, for its event feed. */
  profileId: z.uuid().optional(),
});

/**
 * The pull request whose conflicts the agent of a chat should resolve. The gateway writes the
 * brief itself, as a note the agent reads and the conversation does not show.
 */
export const githubFixConflictsInputSchema = z.strictObject({
  owner: githubOwnerSchema,
  repo: githubRepoSchema,
  number: z.number().int().positive().max(10_000_000),
});

export const githubMergeResultSchema = z.strictObject({
  merged: z.literal(true),
  sha: z.string().max(64),
  message: z.string().max(500),
});

export type GitHubPull = z.infer<typeof githubPullSchema>;
export type GitHubIssue = z.infer<typeof githubIssueSchema>;
export type GitHubLinkSummary = z.infer<typeof githubLinkSummarySchema>;
export type GitHubCheck = z.infer<typeof githubCheckSchema>;
export type GitHubMergeable = z.infer<typeof githubMergeableSchema>;
export type GitHubMergeMethod = z.infer<typeof githubMergeMethodSchema>;
