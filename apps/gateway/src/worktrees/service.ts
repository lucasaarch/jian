import { realpath } from 'node:fs/promises';
import type { Session, SessionWorktree } from '@jian/contracts';
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
  WorktreeProblem,
  worktreeRoot,
  worktreeState,
} from './git.js';
import { randomName } from './names.js';
import {
  activeWorktrees,
  conversationAndSubagentSessions,
  insertWorktree,
  madeFrom,
  markRemoved,
  markRemovedIn,
  openConversations,
  profileWorktrees,
  settledRuns,
  type WorktreeRecord,
  workingFolders,
  worktreeHolders,
} from './repository.js';

export type { WorktreeRecord };

/** A worktree with where it stands; whether a pull request applies is the route's to add. */
export type WorktreeState = Omit<SessionWorktree, 'pullRequest'>;

/** Where git runs for `place`: the gateway, or the id of a machine. */
export type WorktreePlaces = (profileId: string, place: 'gateway' | string) => Promise<GitPlace>;

/** How long a folder's uncommitted count is trusted, in ms: a turn must not run git every time. */
const SIGNAL_FRESH_MS = 60_000;

/**
 * How long what a machine said about a worktree is trusted, in ms. The badge reads its
 * worktrees as each turn starts and ends, and on a machine every read is a task its worker runs.
 */
const MACHINE_FRESH_MS = 30_000;

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
  /** Where a machine's worktree stood, by `place|path`, and how the conversation's runs stood. */
  private readonly standing = new Map<
    string,
    { at: number; runs: string; state: Awaited<ReturnType<typeof worktreeState>> }
  >();
  /** A machine's source's GitHub repository, by `place|source`. */
  private readonly origins = new Map<string, { at: number; repository: string | null }>();

  /** A kept answer from a machine, while it is fresh; the gateway's own disk is always asked. */
  private fresh<T extends { at: number }>(kept: Map<string, T>, place: string, path: string) {
    if (place === 'gateway') return undefined;
    const found = kept.get(`${place}|${path}`);
    return found && this.clock() - found.at < MACHINE_FRESH_MS ? found : undefined;
  }

  /** What was done to a worktree is read again at once. */
  private forget(record: WorktreeRecord) {
    this.standing.delete(`${record.place}|${record.path}`);
  }

  /**
   * What each folder's turn-start signal says: its changed files, who else works there and the
   * conversation's own worktree for it. The folders are those the conversation works on (see
   * `workingFolders`), and the source of each worktree it has, which it works on whatever its
   * folders say. On the gateway git is asked once a minute per folder; on a machine nothing is,
   * since a turn must not wait for a remote command: its signal is who else is there and what was
   * recorded. A folder outside any repository has no signal.
   */
  async signals(
    profileId: string,
    conversation: Pick<
      Session,
      'id' | 'projectId' | 'projectIds' | 'folders' | 'cloneInto' | 'remoteMachineId'
    >,
  ): Promise<FolderSignal[]> {
    const sessionId = conversation.id;
    const place = conversation.remoteMachineId ?? 'gateway';
    const ours = (await activeWorktrees(this.store.db, profileId, sessionId)).filter(
      (record) => record.place === place,
    );
    const folders =
      (
        await workingFolders(this.store.db, [
          {
            sessionId,
            projectId: conversation.projectId ?? null,
            remoteMachineId: conversation.remoteMachineId ?? null,
            workspace: {
              ...(conversation.folders ? { folders: conversation.folders } : {}),
              ...(conversation.projectIds ? { projectIds: conversation.projectIds } : {}),
              ...(conversation.cloneInto ? { cloneInto: conversation.cloneInto } : {}),
            },
          },
        ])
      ).get(sessionId) ?? [];
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
    for (const record of ours) {
      if (!found.some((item) => item.source === record.source)) {
        found.push({ folder: record.source, source: record.source });
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

  /**
   * Where each of the conversation's worktrees stands. A machine's answer is kept for a while
   * (`MACHINE_FRESH_MS`) unless `fresh`, which the agent and a discard ask for, and is never
   * served once one of the conversation's runs has ended since: the badge reads it as a turn
   * ends, and must not show the counts from before the agent's edits.
   */
  async list(
    profileId: string,
    sessionId: string,
    options: { fresh?: boolean } = {},
  ): Promise<WorktreeState[]> {
    const records = await activeWorktrees(this.store.db, profileId, sessionId);
    const states: WorktreeState[] = [];
    const machines = records.some((record) => record.place !== 'gateway');
    const runs = machines ? await settledRuns(this.store.db, profileId, sessionId) : '';
    // Each place is reached once per list: a machine's is looked up among the machines.
    const reached = new Map<string, Promise<GitPlace>>();
    const at = (place: string) => {
      const known = reached.get(place) ?? this.places(profileId, place);
      reached.set(place, known);
      return known;
    };

    for (const record of records) {
      const kept = options.fresh ? undefined : this.fresh(this.standing, record.place, record.path);
      if (kept && kept.runs === runs) {
        states.push({ ...describe(record), ...kept.state });
        continue;
      }
      try {
        const git = await at(record.place);
        if (!(await this.stillThere(git, record))) {
          await this.retire(profileId, sessionId, record);
          continue;
        }
        const state = await worktreeState(git, record);
        if (record.place !== 'gateway') {
          this.standing.set(`${record.place}|${record.path}`, { at: this.clock(), runs, state });
        }
        states.push({ ...describe(record), ...state });
      } catch {
        // Offline machine or unreadable source: the row is not proof the folder is gone.
        states.push({ ...describe(record), ahead: null, behind: null, uncommitted: null });
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

  /** Every active worktree of the profile, whichever conversation holds it. */
  recordedForProfile(profileId: string): Promise<WorktreeRecord[]> {
    return profileWorktrees(this.store.db, profileId);
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
    const kept = this.fresh(this.origins, record.place, record.source);
    if (kept) return kept.repository;
    const repository = await this.originOf(profileId, record);
    if (record.place !== 'gateway') {
      this.origins.set(`${record.place}|${record.source}`, { at: this.clock(), repository });
    }
    return repository;
  }

  private async originOf(profileId: string, record: WorktreeRecord): Promise<string | null> {
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
    this.forget(record);
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
    await this.refuseWhileMadeFrom(profileId, record);
    const git = await this.places(profileId, record.place);
    // A subagent merges back into the conversation's worktree, whose changes are no owner's.
    const into = (await profileWorktrees(this.store.db, profileId)).some(
      (other) => other.path === record.source && other.place === record.place,
    )
      ? 'worktree'
      : 'folder';
    const { sha } = await mergeWorktree(git, { ...record, into });
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
    await this.refuseWhileMadeFrom(profileId, record);
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
   * For a conversation or profile being deleted: deleting takes the rows with it, so the caller
   * reads them first and clears the folders once the delete has committed. Folders go; a branch
   * with commits not in the base stays, so no work is lost. A machine that cannot be reached
   * leaves its folder behind, said in the log.
   *
   * A worktree made from another one (a subagent's, from its parent's) goes first: git cannot
   * remove a checkout from inside a folder that is already gone.
   */
  async clear(profileId: string, records: WorktreeRecord[]): Promise<void> {
    const depth = (record: WorktreeRecord, seen = 0): number => {
      const parent = records.find((other) => other.path === record.source);
      return parent && seen < records.length ? 1 + depth(parent, seen + 1) : 0;
    };
    const deepestFirst = [...records].sort((a, b) => depth(b) - depth(a));
    const removed: string[] = [];
    for (const record of deepestFirst) {
      try {
        const git = await this.places(profileId, record.place);
        await removeWorktree(git, { ...record, discard: true, deleteBranch: false });
        removed.push(record.id);
      } catch (error) {
        this.warn(
          `Worktree ${record.path} was left on ${record.place}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
    // A subagent's task session outlives the conversation: its rows would stay active, and a
    // reset would try them again. What could not be removed stays active, to be tried again.
    await markRemovedIn(this.store.db, this.clock, profileId, removed).catch((error) =>
      this.warn(`Could not mark removed worktrees: ${String(error)}`),
    );
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
      // A folder is stored as the owner chose it; the sources are what git calls the checkout.
      const folders = await Promise.all(other.folders.map(realOrSame));
      for (const source of sources) {
        const works =
          folders.some((folder) => overlaps(folder, source)) ||
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

  /**
   * A worktree another one was made from cannot go first: the subagent's would lose the branch
   * it merges back into, and git cannot remove a checkout whose source is gone. One whose folder
   * was deleted by hand no longer counts; one whose place cannot be read still does.
   */
  private async refuseWhileMadeFrom(profileId: string, record: WorktreeRecord) {
    for (const child of await madeFrom(this.store.db, profileId, record.path)) {
      const there = await this.places(profileId, child.place)
        .then((git) => this.stillThere(git, child))
        .catch(() => true);
      if (!there) {
        await this.retire(profileId, child.sessionId, child);
        continue;
      }
      throw new WorktreeProblem(
        `${record.name} has a subagent's worktree made from it: merge or remove the subagent's worktree ${child.name} first.`,
      );
    }
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
    this.forget(record);
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

/** The real path where it exists here; a machine's path, or one gone, is compared as written. */
const realOrSame = (path: string) => realpath(path).catch(() => path);

/**
 * Whether two folders share files: the same, or one inside the other. Another conversation in a
 * folder of the repository, or in one that holds it, works on the same checkout.
 */
function overlaps(a: string, b: string): boolean {
  const within = (inner: string, outer: string) =>
    inner.startsWith(/[\\/]$/.test(outer) ? outer : `${outer}/`) || inner.startsWith(`${outer}\\`);
  return a === b || within(a, b) || within(b, a);
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
