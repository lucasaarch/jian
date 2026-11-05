import type { SessionWorktree } from '@jian/contracts';
import { ORIGIN_QUERY, originUrls } from '../agent/github-git-command.js';
import type { GitPlace } from '../agent/github-git-place.js';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { Store } from '../storage/database.js';
import {
  addWorktree,
  checkoutSignal,
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
  conversationAndSubagentSessions,
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

/** How long a folder's uncommitted count is trusted, in ms: a turn must not run git every time. */
const SIGNAL_FRESH_MS = 60_000;

/** What a turn tells the agent about one folder it works in. */
export type FolderSignal = {
  folder: string;
  /** Files with uncommitted changes in the folder's checkout; absent on a machine. */
  uncommitted?: number;
  others: { agent?: string; conversation?: string }[];
  worktree?: { name: string; path: string; branch: string; base: string };
};

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

  private readonly seen = new Map<
    string,
    { at: number; checkout: { top: string; uncommitted: number } | null }
  >();

  /**
   * What each folder's turn-start signal says: its changed files, who else works there and the
   * conversation's own worktree for it. On the gateway git is asked once a minute per folder; on a
   * machine nothing is, since a turn must not wait for a remote command: its signal is who else
   * is there and what was recorded. A folder outside any repository has no signal.
   */
  async signals(
    profileId: string,
    sessionId: string,
    folders: string[],
    place: 'gateway' | string,
  ): Promise<FolderSignal[]> {
    const ours = (await activeWorktrees(this.store.db, profileId, sessionId)).filter(
      (record) => record.place === place,
    );
    const found: { folder: string; source: string; uncommitted?: number }[] = [];

    for (const folder of folders) {
      if (place !== 'gateway') {
        found.push({ folder, source: folder });
        continue;
      }
      const checkout = await this.checkoutOf(profileId, folder).catch(() => null);
      if (checkout) {
        found.push({ folder, source: checkout.top, uncommitted: checkout.uncommitted });
      }
    }

    const neighbours = await this.neighbours(
      profileId,
      sessionId,
      found.map((item) => item.source),
    );
    return found.map(({ folder, source, uncommitted }) => {
      const own = ours.find((record) => record.source === source);
      return {
        folder,
        ...(uncommitted === undefined ? {} : { uncommitted }),
        others: neighbours
          .filter((item) => item.source === source)
          .map(({ agent, conversation }) => ({
            ...(agent ? { agent } : {}),
            ...(conversation ? { conversation } : {}),
          })),
        ...(own
          ? { worktree: { name: own.name, path: own.path, branch: own.branch, base: own.base } }
          : {}),
      };
    });
  }

  /** Every active worktree of the conversation, as recorded and wherever it is. */
  recorded(profileId: string, sessionId: string): Promise<WorktreeRecord[]> {
    return activeWorktrees(this.store.db, profileId, sessionId);
  }

  private async checkoutOf(profileId: string, folder: string) {
    const now = this.clock();
    const kept = this.seen.get(folder);
    if (kept && now - kept.at < SIGNAL_FRESH_MS) return kept.checkout;
    const checkout = await checkoutSignal(await this.places(profileId, 'gateway'), folder);
    this.seen.set(folder, { at: now, checkout });
    return checkout;
  }

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

  /**
   * The same, as recorded, without asking git: one indexed query, cheap enough before every tool
   * call, so a run sees what another run of its conversation made or removed a moment ago.
   */
  async recordedOnGateway(profileId: string, sessionId: string): Promise<WorktreeRecord[]> {
    return (await activeWorktrees(this.store.db, profileId, sessionId)).filter(
      (record) => record.place === 'gateway',
    );
  }

  /** The conversation's own id first, then its subagents' task sessions. */
  conversationSessions(profileId: string, sessionId: string): Promise<string[]> {
    return conversationAndSubagentSessions(this.store.db, profileId, sessionId);
  }

  /**
   * `owner/repo` when the source's origin is a github.com repository, else null. One git read at
   * the worktree's place; a place that cannot answer is simply not a pull request candidate.
   */
  async githubRepository(profileId: string, record: WorktreeRecord): Promise<string | null> {
    try {
      const git = await this.places(profileId, record.place);
      const outcome = await git.git(['-C', record.source, ...ORIGIN_QUERY]);
      if (outcome.exitCode !== 0) return null;
      for (const url of originUrls(outcome.stdout)) {
        const match =
          /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
            url,
          );
        if (match) return `${match[1]}/${match[2]}`;
      }
      return null;
    } catch {
      return null;
    }
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
    const records = await activeWorktrees(this.store.db, profileId, sessionId);
    await this.clear(profileId, records);
    for (const record of records) await this.retire(profileId, sessionId, record);
  }

  /**
   * The same cleanup for records read earlier: deleting a conversation takes its rows with it, so
   * the route reads them first and clears the folders once the delete has committed.
   */
  async clear(profileId: string, records: WorktreeRecord[]): Promise<void> {
    for (const record of records) {
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
