import { z } from 'zod';
import {
  githubChecksSummarySchema,
  githubMergeableSchema,
  githubOwnerSchema,
  githubRepoSchema,
} from './github-items.js';

/**
 * The pull requests of every account the GitHub App is installed on, and the agent reviews the
 * owner starts on them or lets a new one start by itself. Only a server gateway offers them: a
 * GitHub webhook needs an address GitHub can reach.
 */

/** `owner/name`, as GitHub spells a repository's full name. */
export const githubFullNameSchema = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/);

/** Open: every open one. Mine: opened by the owner's own GitHub account. Review: awaiting one. */
export const githubPullFilterSchema = z.enum(['open', 'mine', 'review']);

export const githubPullListQuerySchema = z.strictObject({
  filter: githubPullFilterSchema.optional(),
  repository: githubFullNameSchema.optional(),
  /** Words or GitHub search qualifiers, added to the filter's own. */
  q: z.string().max(200).optional(),
});

const personSchema = z.strictObject({
  login: z.string().min(1).max(100),
  avatarUrl: z.url().max(500).optional(),
});

/** A reviewer of a pull request: asked and not yet answered, or their latest review. */
export const githubPullReviewerSchema = personSchema.extend({
  state: z.enum([
    'requested',
    'approved',
    'changes_requested',
    'commented',
    'dismissed',
    'pending',
  ]),
});

/** The latest review an agent was asked for on a pull request, and the chat it works in. */
export const githubAgentReviewSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  sessionId: z.uuid(),
  /** `auto` when the gateway started it on GitHub's word that the pull request was opened. */
  trigger: z.enum(['manual', 'auto']),
  headSha: z.string().max(64),
  createdAt: z.iso.datetime(),
});

export const githubPullRowSchema = z.strictObject({
  owner: githubOwnerSchema,
  repo: githubRepoSchema,
  number: z.number().int().positive(),
  url: z.url().max(1000),
  title: z.string().max(1000),
  draft: z.boolean(),
  author: personSchema.optional(),
  headRef: z.string().max(255),
  headSha: z.string().max(64),
  labels: z.array(z.strictObject({ name: z.string().max(100), color: z.string().max(6) })).max(10),
  reviewers: z.array(githubPullReviewerSchema).max(20),
  /** Left out when the repository requires no review. */
  reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).optional(),
  /** Left out when the head commit has no checks at all. */
  checks: githubChecksSummarySchema.optional(),
  mergeable: githubMergeableSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  review: githubAgentReviewSchema.optional(),
});

export const githubPullListSchema = z.strictObject({
  pulls: z.array(githubPullRowSchema).max(500),
  /** An account had more than one page of pull requests: only its most recently updated are here. */
  truncated: z.boolean(),
  /** Connected accounts GitHub would not answer for, whose pull requests are missing. */
  unreachable: z.array(z.string().max(100)).max(50),
});

/** How agent reviews run, for the whole installation. */
export const githubReviewSettingsSchema = z.strictObject({
  /** The agent that reviews. Absent, a review asked for in the panel goes to the agent open there. */
  profileId: z.uuid().optional(),
  /** What the reviewer is told to look for and how to answer, beyond the pull request itself. */
  instructions: z.string().max(8000),
  /** Review each pull request as it is opened, or marked ready, once the webhook is set up. */
  auto: z.boolean(),
  /** Review drafts automatically too, instead of waiting until they are ready. */
  drafts: z.boolean(),
  /** The repositories automatic reviews cover; empty is all of them. */
  repositories: z.array(githubFullNameSchema).max(200),
});

export const githubReviewsStatusSchema = z.strictObject({
  settings: githubReviewSettingsSchema,
  webhook: z.strictObject({
    /** The App's webhook was pointed here, with a secret this gateway holds. */
    configured: z.boolean(),
    /** Where GitHub delivers, absent without a public address. */
    url: z.url().optional(),
    /** The App's settings on GitHub, where its events are chosen. */
    appSettingsUrl: z.url().optional(),
    /** When GitHub last delivered something this gateway accepted. */
    receivedAt: z.iso.datetime().optional(),
  }),
});

export const githubStartReviewInputSchema = z.strictObject({
  /** The agent that reviews: the panel sends the one the settings name, or the one open there. */
  profileId: z.uuid(),
});

export type GitHubPullFilter = z.infer<typeof githubPullFilterSchema>;
export type GitHubPullRow = z.infer<typeof githubPullRowSchema>;
export type GitHubPullList = z.infer<typeof githubPullListSchema>;
export type GitHubPullReviewer = z.infer<typeof githubPullReviewerSchema>;
export type GitHubAgentReview = z.infer<typeof githubAgentReviewSchema>;
export type GitHubReviewSettings = z.infer<typeof githubReviewSettingsSchema>;
export type GitHubReviewsStatus = z.infer<typeof githubReviewsStatusSchema>;
