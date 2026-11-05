import { join, relative, sep } from 'node:path';
import { worktreeNameSchema } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { WorktreeRecord, Worktrees } from '../worktrees/service.js';
import { type GuardedSource, realFolders } from './workspace.js';

export type WorktreeService = Pick<
  Worktrees,
  | 'create'
  | 'list'
  | 'find'
  | 'update'
  | 'merge'
  | 'remove'
  | 'onGateway'
  | 'recordedOnGateway'
  | 'recordedOnMachine'
  | 'conversationSessions'
>;

type Records = (profileId: string, sessionId: string) => Promise<WorktreeRecord[]>;

/** Records as the checks compare them: real paths, as the folders' are. */
const guardsOf = (records: WorktreeRecord[]) =>
  Promise.all(
    records.map(async (record) => {
      const [source, worktree] = await realFolders([record.source, record.path]);
      return { source: source as string, worktree: worktree as string };
    }),
  );

/**
 * The sources a run's file tools guard. Checked against git when the run starts, then read from
 * the records before every tool call: another run of the conversation (the parent, a subagent)
 * may make or remove a worktree while this one works, and a stale guard would let a write through
 * or send it to a folder that is gone.
 *
 * A subagent's own worktrees are its task session's, made from the conversation's: it guards the
 * conversation's sources (`parent`) and, through its own, the conversation's worktrees too.
 */
export class RunWorktrees {
  parent: readonly GuardedSource[] = [];
  own: readonly GuardedSource[] = [];
  /**
   * The sources of this run's worktrees on its target machine, as recorded, for the file tools
   * there. Machine paths, not real ones: the gateway cannot resolve a path on another machine.
   */
  machine: readonly GuardedSource[] = [];

  constructor(
    private readonly worktrees: Pick<
      WorktreeService,
      'onGateway' | 'recordedOnGateway' | 'recordedOnMachine'
    >,
    private readonly profileId: string,
    /** This run's session: a subagent's task session, or the conversation itself. */
    readonly sessionId: string,
    /** The conversation: for a subagent, the one that started it. */
    readonly conversationId: string,
    /** The machine this run's own session targets, whose file tools it guards. */
    private readonly machineId?: string,
  ) {}

  get subagent() {
    return this.sessionId !== this.conversationId;
  }

  /** In the order `reachableFolders` follows: the conversation's first, then this run's. */
  get guarded(): readonly GuardedSource[] {
    return [...this.parent, ...this.own];
  }

  /** At the start of the run, with git asked whether each folder on the gateway is still there. */
  start(): Promise<void> {
    return this.read((profileId, sessionId) => this.worktrees.onGateway(profileId, sessionId));
  }

  /** Before each tool call, from the records alone. */
  reload(): Promise<void> {
    return this.read((profileId, sessionId) =>
      this.worktrees.recordedOnGateway(profileId, sessionId),
    );
  }

  private async read(records: Records) {
    try {
      const own = await guardsOf(await records(this.profileId, this.sessionId));
      const parent = this.subagent
        ? await guardsOf(await records(this.profileId, this.conversationId))
        : [];
      const machine = this.machineId
        ? (
            await this.worktrees.recordedOnMachine(this.profileId, this.sessionId, this.machineId)
          ).map(({ source, path }) => ({ source, worktree: path }))
        : [];
      this.own = own;
      this.parent = parent;
      this.machine = machine;
    } catch (error) {
      // What was guarded stays guarded, and the next call reads again.
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

const isNotFound = (error: unknown) => error instanceof GatewayError && error.statusCode === 404;

/**
 * The agent's hands on its worktrees. A run makes worktrees in its own session (`scope.sessionId`)
 * and sees the conversation's too: for a subagent, its task session's and its parent's, so
 * parallel subagents each make their own from the conversation's worktree and merge back into it.
 * On the gateway a worktree is made only of a repository inside the conversation's folders
 * (`folders`, real paths), or for a subagent of the conversation's worktree; a conversation on a
 * machine already runs any command there, so any of its paths will do.
 *
 * `place` is where this run's own tools reach, not where the conversation is: a subagent's task
 * session targets no machine, so its commands run here, and a worktree it made on the machine
 * would be one it could not work in. The other tools act on each record at its own place.
 */
export function worktreeTools({
  worktrees,
  profileId,
  place,
  folders,
  scope,
  machineFiles = false,
}: {
  worktrees: WorktreeService;
  profileId: string;
  place: 'gateway' | string;
  /** The run's file tools work on that machine, so they are the ones the worktree steers. */
  machineFiles?: boolean;
  folders: readonly string[];
  scope: RunWorktrees;
}): ToolSet {
  const { sessionId, conversationId, subagent } = scope;
  const fromParent = scope.parent.map(({ worktree }) => worktree);
  const where =
    place === 'gateway'
      ? `The folder must be inside ${[
          ...(folders.length ? [`this conversation's folders: ${folders.join(', ')}`] : []),
          ...(fromParent.length ? [`the conversation's worktrees: ${fromParent.join(', ')}`] : []),
        ].join(', or ')}.`
      : 'Give the absolute path of the repository on the machine this conversation works on.';
  /** The conversation's subagents' task sessions, for the conversation itself. */
  const subagents = async () =>
    subagent
      ? []
      : (await worktrees.conversationSessions(profileId, conversationId)).filter(
          (id) => id !== sessionId,
        );
  /**
   * The session that holds `name`: this run's own first, then, for a subagent, the
   * conversation's, and for the conversation, its subagents'. A worktree is found by both ids.
   */
  const holder = async (name: string) => {
    const others = subagent ? [conversationId] : await subagents();
    for (const id of [sessionId, ...others]) {
      const found = await worktrees.find(profileId, id, name).then(
        () => true,
        (error: unknown) => {
          if (isNotFound(error)) return false;
          throw error;
        },
      );
      if (found) return id;
    }
    return sessionId;
  };

  // The agent decides from what it is told: never a count kept from before its own edits.
  const live = { fresh: true };
  // Only a run on the gateway has subagents that make worktrees, and only from the conversation's.
  const parentOfSubagents = !subagent && place === 'gateway';
  const madeFromIt = parentOfSubagents
    ? " Refused while a subagent's worktree made from it is there: merge or remove that one first, since a subagent's worktree from list_worktrees is yours to act on too."
    : '';

  const tools: ToolSet = {
    create_worktree: tool({
      description: `Make your own checkout of a repository: a folder outside it and a branch jian/<name> from the branch the folder has checked out, so you work without touching the owner's checkout. ${
        place === 'gateway'
          ? 'While it exists, the file tools refuse writes in the source and commands start in the worktree.'
          : machineFiles
            ? 'While it exists, your file tools refuse writes in the source on the machine. Commands do not start in the worktree: set cwd of run_remote_command to its path, never to the source folder.'
            : "Nothing sends your commands there on the machine: set cwd of run_remote_command to the worktree's path, never to the source folder. You have no file tools there; updating Jian Remote on that machine (for This computer, the desktop app) gives you them."
      } ${where}${
        subagent
          ? " As a subagent, you make your own worktree from the conversation's worktree (its path, or the source folder, leads there) and merge it back into that worktree with merge_worktree."
          : ''
      } Refused when the folder is not a git repository (give the repository's folder), on a detached HEAD (ask the owner to check out a branch), or when you already have one for that repository (use it, or remove it first).`,
      inputSchema: z.object({
        folder: absolute.describe('The repository, or a folder inside it.'),
      }),
      execute: async ({ folder }) => {
        let from = folder;
        if (place === 'gateway') {
          let [real] = (await realFolders([folder])) as [string];
          // A subagent's worktree comes from the conversation's, never from the owner's checkout.
          const held = scope.parent.find(({ source }) => inside(real, source));
          if (held) real = join(held.worktree, relative(held.source, real));
          const allowed = [...folders, ...scope.parent.map(({ worktree }) => worktree)];
          if (!allowed.some((root) => inside(real, root))) {
            // A hint keeps the agent's copy of the failure whole, folders and all.
            throw Object.assign(
              new GatewayError(403, `${folder} is not in this conversation's folders.`),
              { hint: where },
            );
          }
          from = real;
        }
        return worktrees.create(profileId, sessionId, from, place);
      },
    }),
    list_worktrees: tool({
      description: `${
        subagent
          ? "Your worktrees, then the conversation's"
          : parentOfSubagents
            ? "This conversation's worktrees, then its subagents' (marked subagent: true)"
            : "This conversation's worktrees"
      }: name, branch, base, source and path, with commits ahead of and behind the base and uncommitted files. A count is null when its machine could not be read; try again once it is online.`,
      inputSchema: z.object({}),
      execute: async () => {
        if (subagent) {
          return [
            ...(await worktrees.list(profileId, sessionId, live)),
            ...(await worktrees.list(profileId, conversationId, live)),
          ];
        }
        const theirs = [];
        for (const id of await subagents()) {
          for (const item of await worktrees.list(profileId, id, live)) {
            theirs.push({ ...item, subagent: true });
          }
        }
        return [...(await worktrees.list(profileId, sessionId, live)), ...theirs];
      },
    }),
    update_worktree: tool({
      description:
        "Bring the base branch into a worktree's branch, inside the worktree, by merge (the default) or rebase. Conflicts stay in the worktree and are listed: resolve and commit them there. Refused with uncommitted changes in the worktree: commit them first.",
      inputSchema: z.object({
        name: worktreeNameSchema,
        strategy: z.enum(['merge', 'rebase']).default('merge'),
      }),
      execute: async ({ name, strategy }) =>
        worktrees.update(profileId, await holder(name), name, strategy),
    }),
    merge_worktree: tool({
      description: `Merge a worktree's branch into the folder it came from, then remove the worktree and the merged branch. Only when the owner asked${
        subagent
          ? ', or, for a worktree of your own, when your work in it is done'
          : parentOfSubagents
            ? ", or, for a subagent's worktree, when its work is done"
            : ''
      }. Refused with uncommitted changes in the worktree (commit them first), when its branch lacks the latest base (run update_worktree first), or when the source folder has uncommitted changes or another branch checked out (ask the owner to commit, stash or check out the base). The result says what was left behind when the cleanup after a merge did not finish.${madeFromIt}`,
      inputSchema: z.object({ name: worktreeNameSchema }),
      execute: async ({ name }) => worktrees.merge(profileId, await holder(name), name),
    }),
    remove_worktree: tool({
      description: `Remove a worktree. Its branch is deleted only when the base has all its commits, or with deleteBranch. Refused with uncommitted changes: commit them, or pass discard only when the owner asked to throw them away.${madeFromIt}`,
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
      execute: async ({ name, discard, deleteBranch }) =>
        worktrees.remove(profileId, await holder(name), name, {
          ...(discard !== undefined ? { discard } : {}),
          ...(deleteBranch !== undefined ? { deleteBranch } : {}),
        }),
    }),
  };
  // On the gateway a worktree needs a folder to come from; without one the tool could only refuse.
  if (place === 'gateway' && folders.length === 0 && fromParent.length === 0) {
    delete tools.create_worktree;
  }
  return tools;
}
