import { sep } from 'node:path';
import { worktreeNameSchema } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { Worktrees } from '../worktrees/service.js';
import { type GuardedSource, realFolders } from './workspace.js';

export type WorktreeService = Pick<
  Worktrees,
  'create' | 'list' | 'update' | 'merge' | 'remove' | 'onGateway'
>;

/**
 * The sources a run's file tools guard, read once when the run starts and again after any worktree
 * tool returns, so a call never works from a worktree that was merged or removed a step ago.
 */
export class RunWorktrees {
  guarded: readonly GuardedSource[] = [];

  constructor(
    private readonly worktrees: Pick<WorktreeService, 'onGateway'>,
    private readonly profileId: string,
    private readonly sessionId: string,
  ) {}

  async refresh(): Promise<void> {
    try {
      const records = await this.worktrees.onGateway(this.profileId, this.sessionId);
      // The checks compare real paths, as the folders' are.
      this.guarded = await Promise.all(
        records.map(async (record) => {
          const [source, worktree] = await realFolders([record.source, record.path]);
          return { source: source as string, worktree: worktree as string };
        }),
      );
    } catch (error) {
      // What was guarded stays guarded; a run that cannot read them starts with none.
      console.error(
        'jian: the worktrees of a conversation could not be read',
        error instanceof Error ? error.message : error,
      );
    }
  }
}

/** A path on the gateway or a machine, which may be Windows: `/…`, `C:\…` or `C:/…`. */
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => /^(?:\/|[A-Za-z]:[\\/])/.test(value), 'Use an absolute path');

const inside = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * The agent's hands on its conversation's worktrees. `sessionId` is the conversation's, which for a
 * subagent is the one that started it: a subagent works in its parent's worktrees. On the gateway a
 * worktree is made only of a repository inside the conversation's folders (`folders`, real paths);
 * a conversation on a machine already runs any command there, so any of its paths will do.
 */
export function worktreeTools({
  worktrees,
  profileId,
  sessionId,
  place,
  folders,
  scope,
}: {
  worktrees: WorktreeService;
  profileId: string;
  sessionId: string;
  place: 'gateway' | string;
  folders: readonly string[];
  scope: RunWorktrees;
}): ToolSet {
  const changing = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } finally {
      await scope.refresh();
    }
  };
  const where =
    place === 'gateway'
      ? folders.length
        ? `The folder must be inside this conversation's folders: ${folders.join(', ')}.`
        : 'This conversation has no folders on this gateway to make one from.'
      : 'Give the absolute path of the repository on the machine this conversation works on.';

  return {
    create_worktree: tool({
      description: `Make this conversation its own checkout of a repository: a folder outside it and a branch jian/<name> from the branch the folder has checked out, so you work without touching the owner's checkout. While it exists, the file tools refuse writes in the source and commands start in the worktree. ${where} Refused when the folder is not a git repository (give the repository's folder), on a detached HEAD (ask the owner to check out a branch), or when this conversation already has one for that repository (use it, or remove it first).`,
      inputSchema: z.object({
        folder: absolute.describe('The repository, or a folder inside it.'),
      }),
      execute: ({ folder }) =>
        changing(async () => {
          if (place === 'gateway') {
            const [real] = await realFolders([folder]);
            if (!folders.some((root) => inside(real as string, root))) {
              // A hint keeps the agent's copy of the failure whole, folders and all.
              throw Object.assign(
                new GatewayError(403, `${folder} is not in this conversation's folders.`),
                { hint: where },
              );
            }
          }
          return worktrees.create(profileId, sessionId, folder, place);
        }),
    }),
    list_worktrees: tool({
      description:
        "This conversation's worktrees: name, branch, base, source and path, with commits ahead of and behind the base and uncommitted files. A count is null when its machine could not be read; try again once it is online.",
      inputSchema: z.object({}),
      execute: () => changing(() => worktrees.list(profileId, sessionId)),
    }),
    update_worktree: tool({
      description:
        "Bring the base branch into a worktree's branch, inside the worktree, by merge (the default) or rebase. Conflicts stay in the worktree and are listed: resolve and commit them there. Refused with uncommitted changes in the worktree: commit them first.",
      inputSchema: z.object({
        name: worktreeNameSchema,
        strategy: z.enum(['merge', 'rebase']).default('merge'),
      }),
      execute: ({ name, strategy }) =>
        changing(() => worktrees.update(profileId, sessionId, name, strategy)),
    }),
    merge_worktree: tool({
      description:
        "Merge a worktree's branch into the folder it came from, then remove the worktree and the merged branch. Only when the owner asked. Refused with uncommitted changes in the worktree (commit them first), when its branch lacks the latest base (run update_worktree first), or when the source folder has uncommitted changes or another branch checked out (ask the owner to commit, stash or check out the base). The result says what was left behind when the cleanup after a merge did not finish.",
      inputSchema: z.object({ name: worktreeNameSchema }),
      execute: ({ name }) => changing(() => worktrees.merge(profileId, sessionId, name)),
    }),
    remove_worktree: tool({
      description:
        'Remove a worktree. Its branch is deleted only when the base has all its commits, or with deleteBranch. Refused with uncommitted changes: commit them, or pass discard only when the owner asked to throw them away.',
      inputSchema: z.object({
        name: worktreeNameSchema,
        discard: z
          .boolean()
          .optional()
          .describe('Remove it even with uncommitted changes, which are lost.'),
        deleteBranch: z
          .boolean()
          .optional()
          .describe(
            'Also delete a branch with commits not in the base, which are lost. Only when the owner asked.',
          ),
      }),
      execute: ({ name, discard, deleteBranch }) =>
        changing(() =>
          worktrees.remove(profileId, sessionId, name, {
            ...(discard !== undefined ? { discard } : {}),
            ...(deleteBranch !== undefined ? { deleteBranch } : {}),
          }),
        ),
    }),
  };
}
