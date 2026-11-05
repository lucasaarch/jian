import type { SessionWorktree } from '@jian/contracts';
import type { GitPlace } from '../agent/github-git-place.js';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { Store } from '../storage/database.js';
import {
  addWorktree,
  listedWorktrees,
  mergeWorktree,
  removeWorktree,
  sourceOf,
  updateWorktree,
  worktreeRoot,
  worktreeState,
} from './git.js';
import { randomName } from './names.js';
import {
  activeWorktrees,
  insertWorktree,
  markRemoved,
  openConversations,
  type WorktreeRecord,
  worktreeHolders,
} from './repository.js';

export type { WorktreeRecord };

/** A worktree with where it stands; whether a pull request applies is the route's to add. */
export type WorktreeState = Omit<SessionWorktree, 'pullRequest'>;

/** Where git runs for `place`: the gateway, or the id of a machine. */
export type WorktreePlaces = (profileId: string, place: 'gateway' | string) => Promise<GitPlace>;

type Change = 'created' | 'merged' | 'removed';

/**
 * A conversation's isolated checkouts. Git runs where the folder is; the database only remembers
 * which worktree belongs to which conversation, and every lookup names both, so one conversation
 * can never reach another's.
 */
export class Worktrees {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly places: WorktreePlaces,
    private readonly warn: (message: string) => void = () => {},
    private readonly random: () => number = Math.random,
  ) {}

  async create(
    profileId: string,
    sessionId: string,
    folder: string,
    place: 'gateway' | string,
  ): Promise<SessionWorktree> {
    const git = await this.places(profileId, place);
    const { top, branch: base } = await sourceOf(git, folder);

    const existing = (await activeWorktrees(this.store.db, profileId, sessionId)).find(
      (item) => item.source === top,
    );
    if (existing) {
      // A folder deleted by hand must not keep the slot taken.
      if (await this.stillThere(git, existing)) throw alreadyHas(existing, top);
      await this.retire(profileId, sessionId, existing);
    }

    const active = new Set(
      (await activeWorktrees(this.store.db, profileId, sessionId)).map((item) => item.name),
    );
    const root = await worktreeRoot(git, top);
    // Branches and folders outlive a removal (a kept branch) and are shared by every
    // conversation on the source, so a name is free only if neither exists on the place.
    const name = await randomName(async (candidate) => {
      if (active.has(candidate)) return true;
      const branchRef = `refs/heads/jian/${candidate}`;
      const ref = await git.git(['-C', top, 'show-ref', '--verify', '--quiet', branchRef]);
      if (ref.exitCode === 0) return true;
      return (await listedWorktrees(git, top)).has(git.join(root, candidate));
    }, this.random);
    const path = git.join(root, name);
    const branch = `jian/${name}`;
    await addWorktree(git, { source: top, path, branch, base });

    let record: WorktreeRecord;
    try {
      record = await this.store.transaction(profileId, async (tx) => {
        const created = await insertWorktree(tx, this.clock, profileId, sessionId, {
          name,
          branch,
          base,
          source: top,
          path,
          place,
        });
        await this.announce(tx, profileId, sessionId, name, 'created');
        return created;
      });
    } catch (error) {
      // A concurrent create won the slot: undo what this one made so nothing is left untracked.
      await removeWorktree(git, {
        source: top,
        path,
        branch,
        base,
        discard: true,
        deleteBranch: true,
      }).catch((cleanup) => this.warn(`Could not clean up ${path}: ${String(cleanup)}`));
      if (isUniqueViolation(error)) {
        const winner = (await activeWorktrees(this.store.db, profileId, sessionId)).find(
          (item) => item.source === top,
        );
        if (winner) throw alreadyHas(winner, top);
      }
      throw error;
    }
    return { ...describe(record), ahead: 0, behind: 0, uncommitted: 0, pullRequest: false };
  }

  async list(profileId: string, sessionId: string): Promise<WorktreeState[]> {
    const records = await activeWorktrees(this.store.db, profileId, sessionId);
    const states: WorktreeState[] = [];

    for (const record of records) {
      const unknown = { ahead: null, behind: null, uncommitted: null };
      try {
        const git = await this.places(profileId, record.place);
        if (!(await this.stillThere(git, record))) {
          await this.retire(profileId, sessionId, record);
          continue;
        }
        states.push({ ...describe(record), ...(await worktreeState(git, record)) });
      } catch {
        // Offline machine or unreadable source: the row is not proof the folder is gone.
        states.push({ ...describe(record), ...unknown });
      }
    }
    return states;
  }

  /**
   * The active worktrees on the gateway's own disk, checked against git there: what a run's file
   * tools steer writes away from. A machine's are left out, since asking would cost a remote call
   * on every turn and the gateway's file tools never reach that disk.
   */
  async onGateway(profileId: string, sessionId: string): Promise<WorktreeRecord[]> {
    const records = (await activeWorktrees(this.store.db, profileId, sessionId)).filter(
      (record) => record.place === 'gateway',
    );
    if (records.length === 0) return [];
    const git = await this.places(profileId, 'gateway');
    const kept: WorktreeRecord[] = [];

    for (const record of records) {
      // A source git cannot read keeps its guard: the row is not proof the folder is gone.
      const there = await this.stillThere(git, record).catch(() => true);
      if (there) kept.push(record);
      else await this.retire(profileId, sessionId, record);
    }
    return kept;
  }

  async find(profileId: string, sessionId: string, name: string): Promise<WorktreeRecord> {
    const found = (await activeWorktrees(this.store.db, profileId, sessionId)).find(
      (item) => item.name === name,
    );
    if (!found) throw new GatewayError(404, `Worktree ${name} not found`);
    return found;
  }

  async update(
    profileId: string,
    sessionId: string,
    name: string,
    strategy: 'merge' | 'rebase',
  ): Promise<{ conflicts: string[] }> {
    const record = await this.find(profileId, sessionId, name);
    const git = await this.places(profileId, record.place);
    return updateWorktree(git, { path: record.path, base: record.base, strategy });
  }

  /** Merges into the source, then removes the worktree and its branch: both are in the base now. */
  async merge(
    profileId: string,
    sessionId: string,
    name: string,
  ): Promise<{ sha: string; leftBehind?: string }> {
    const record = await this.find(profileId, sessionId, name);
    const git = await this.places(profileId, record.place);
    const { sha } = await mergeWorktree(git, record);
    // The merge is done and cannot be undone, so a cleanup that fails must not hide it: a retry
    // would be told the branch lacks the base. The row is retired either way.
    let leftBehind: string | undefined;
    try {
      const removed = await removeWorktree(git, { ...record, discard: false, deleteBranch: true });
      if (removed.branchKept) leftBehind = `The branch ${record.branch} was kept.`;
    } catch (error) {
      leftBehind = `The merge went through, but ${record.path} and the branch ${record.branch} were left behind: ${
        error instanceof Error ? error.message : 'unknown error'
      }`;
    }
    await this.retire(profileId, sessionId, record, 'merged');
    return leftBehind ? { sha, leftBehind } : { sha };
  }

  async remove(
    profileId: string,
    sessionId: string,
    name: string,
    options: { discard?: boolean; deleteBranch?: boolean } = {},
  ): Promise<{ branchKept: boolean }> {
    const record = await this.find(profileId, sessionId, name);
    const git = await this.places(profileId, record.place);
    const result = await removeWorktree(git, {
      ...record,
      discard: options.discard ?? false,
      deleteBranch: options.deleteBranch ?? false,
    });
    await this.retire(profileId, sessionId, record);
    return result;
  }

  /**
   * For a conversation being deleted. Folders go; a branch with commits not in the base stays, so
   * no work is lost. A machine that cannot be reached leaves its folder behind, said in the log.
   */
  async forget(profileId: string, sessionId: string): Promise<void> {
    for (const record of await activeWorktrees(this.store.db, profileId, sessionId)) {
      try {
        const git = await this.places(profileId, record.place);
        await removeWorktree(git, { ...record, discard: true, deleteBranch: false });
      } catch (error) {
        this.warn(
          `Worktree ${record.path} was left on ${record.place}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
      await this.retire(profileId, sessionId, record);
    }
  }

  /**
   * Who else is working on these folders right now. A conversation of the same agent is named by
   * its title; another agent is named by its own name only, because its conversations are private.
   */
  async neighbours(
    profileId: string,
    sessionId: string,
    sources: string[],
  ): Promise<{ source: string; agent?: string; conversation?: string }[]> {
    if (sources.length === 0) return [];
    const open = await openConversations(this.store.db, sessionId);
    const holders = await worktreeHolders(this.store.db, sources);
    const found = new Map<string, { source: string; agent?: string; conversation?: string }>();

    for (const other of open) {
      for (const source of sources) {
        const works =
          other.folders.includes(source) ||
          holders.some((held) => held.sessionId === other.sessionId && held.source === source);
        if (!works) continue;

        const same = other.profileId === profileId;
        found.set(
          `${source}|${same ? other.sessionId : other.profileId}`,
          same
            ? { source, conversation: other.title?.trim() || 'Untitled conversation' }
            : { source, agent: other.profileName },
        );
      }
    }
    return [...found.values()];
  }

  private async stillThere(git: GitPlace, record: WorktreeRecord) {
    return (await listedWorktrees(git, record.source)).has(record.path);
  }

  private async retire(
    profileId: string,
    sessionId: string,
    record: WorktreeRecord,
    change: Change = 'removed',
  ) {
    await this.store.transaction(profileId, async (tx) => {
      if (await markRemoved(tx, this.clock, profileId, sessionId, record.id)) {
        await this.announce(tx, profileId, sessionId, record.name, change);
      }
    });
  }

  private announce(
    tx: Parameters<typeof recordEvent>[0],
    profileId: string,
    sessionId: string,
    name: string,
    change: Change,
  ) {
    return recordEvent(tx, this.clock, profileId, 'session.worktree', { sessionId, name, change });
  }
}

const alreadyHas = (existing: WorktreeRecord, source: string) =>
  new GatewayError(
    409,
    `This conversation already has the worktree ${existing.name} for ${source}. Use it, or remove it first.`,
  );

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null) ?? {};
  return code.code === '23505' || code.cause?.code === '23505';
}

function describe({ id: _id, ...record }: WorktreeRecord) {
  return record;
}
