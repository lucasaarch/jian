import { z } from 'zod';

/**
 * A conversation's isolated checkout of a repository: its own folder and branch, so the agent
 * works without touching what the owner has open. The panel shows where it stands against the
 * folder it came from, and the owner decides what happens to it.
 */

/** Two words and an optional number, so a name reads in a branch and a path and never needs quoting. */
export const worktreeNameSchema = z
  .string()
  .regex(/^[a-z]+-[a-z]+(-\d+)?$/)
  .max(60);

const countSchema = z.number().int().nonnegative().nullable();

export const sessionWorktreeSchema = z.strictObject({
  name: worktreeNameSchema,
  branch: z.string(),
  // The branch the source folder had checked out when the worktree began.
  base: z.string(),
  // The folder the worktree was made from.
  source: z.string(),
  path: z.string(),
  // `gateway`, or the id of the machine the folder is on.
  place: z.union([z.literal('gateway'), z.uuid()]),
  // Null when the place could not be read, such as a machine that is offline.
  ahead: countSchema,
  behind: countSchema,
  uncommitted: countSchema,
  // Whether Open pull request applies to this worktree.
  pullRequest: z.boolean(),
});

export const worktreeUpdateInputSchema = z.strictObject({
  strategy: z.enum(['merge', 'rebase']).default('merge'),
});

export const worktreeParamsSchema = z.strictObject({
  profileId: z.uuid(),
  sessionId: z.uuid(),
  name: worktreeNameSchema,
});

export type SessionWorktree = z.infer<typeof sessionWorktreeSchema>;
export type WorktreeName = z.infer<typeof worktreeNameSchema>;
