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
      if (await this.stillThere(git, existing)) {
        throw new GatewayError(
          409,
          `This conversation already has the worktree ${existing.name} for ${top}. Use it, or remove it first.`,
        );
      }
      await this.retire(profileId, sessionId, existing);
    }

    const taken = new Set(
      (await activeWorktrees(this.store.db, profileId, sessionId)).map((item) => item.name),
    );
    const name = await randomName((candidate) => taken.has(candidate));
    const path = git.join(await worktreeRoot(git, top), name);
    const branch = `jian/${name}`;
    await addWorktree(git, { source: top, path, branch, base });

    const record = await this.store.transaction(profileId, async (tx) => {
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
  async merge(profileId: string, sessionId: string, name: string): Promise<{ sha: string }> {
    const record = await this.find(profileId, sessionId, name);
    const git = await this.places(profileId, record.place);
    const { sha } = await mergeWorktree(git, record);
    await removeWorktree(git, { ...record, discard: false, deleteBranch: true });
    await this.retire(profileId, sessionId, record, 'merged');
    return { sha };
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

function describe({ id: _id, ...record }: WorktreeRecord) {
  return record;
}
