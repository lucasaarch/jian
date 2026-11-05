import { createHash, randomUUID } from 'node:crypto';
import { markSteering } from '../agent/untrusted.js';
import type { Clock } from '../core/clock.js';
import type { Judge } from '../decisions/service.js';
import type { Runs } from '../runs/service.js';
import { pullLinksIn } from '../sessions/pull-links.js';
import type { Store } from '../storage/database.js';
import { type Change, compare, type WatchState } from './changes.js';
import { type LookFailure, lookAt, type PullRef, type RepoRequest } from './look.js';
import { changeNote, lostNote } from './message.js';
import {
  claimWatcher,
  dueWatchers,
  insertWatcher,
  type PullWatcher,
  rememberOwnPush,
  rootSessionOf,
  saveWatcher,
} from './repository.js';

/** How often a watched pull request is looked at, in ms. */
export const WATCH_EVERY_MS = 60_000;
/** The longest wait between looks while GitHub fails, in ms. */
const LONGEST_WAIT_MS = 10 * 60_000;
/** How long looks may fail in a row before the watcher gives up, in ms. */
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
/** Watchers one tick looks at: the rest wait for the next. */
const PER_TICK = 25;

/** GitHub as the watchers reach it: the App's requests and the App's own account. */
export type WatchGitHub = {
  repoRequest: RepoRequest;
  /** `<slug>[bot]`, which signs what the agent writes through the App. */
  appLogin(): Promise<string | undefined>;
};

type Deliveries = {
  /** Called inside the look's transaction, which it must be given: see `tell`. */
  deliverRun(
    profileId: string,
    sessionId: string,
    runId: string,
    transaction: Store['db'],
  ): Promise<void>;
};

/** A tool's answer in a step, as the runtime records it. */
export type ToolAnswer = { toolName: string; result: unknown };

/** The answers of GitHub's `create_pull_request` that went through, read by `created`. */
type IsCreation = (toolName: string) => boolean;

/**
 * The gateway's own watch over the pull requests the agent creates. One opens when a creation
 * goes through, looks every minute, tells the conversation exactly what changed, in the
 * background, and ends when the pull request is merged or closed. The agent has no say in it.
 */
export class PullWatchers {
  private deliveries?: Deliveries;

  constructor(
    private readonly store: Store,
    private readonly runs: Pick<Runs, 'submit'>,
    private readonly isCreation: IsCreation,
    private readonly clock: Clock = Date.now,
    private readonly github?: WatchGitHub,
    private readonly judge?: Judge,
  ) {}

  /** A channel's conversation hears the agent's answer where it lives, as for any turn. */
  useDeliveries(deliveries: Deliveries) {
    this.deliveries = deliveries;
  }

  /**
   * Opens a watcher for each pull request a step of `runId` created. Never fails the run: a
   * watcher that cannot open costs the watch, not the work.
   */
  async created(profileId: string, runId: string, answers: ToolAnswer[]): Promise<void> {
    const pulls = answers
      .filter((answer) => this.isCreation(answer.toolName) && !failed(answer.result))
      .flatMap((answer) => pullLinksIn([JSON.stringify(answer.result) ?? '']));
    if (!pulls.length) return;

    const sessionId = await rootSessionOf(this.store.db, profileId, runId);
    if (!sessionId) return;
    const now = new Date(this.clock());

    for (const { url } of pulls) {
      const pull = refOf(url);
      if (!pull) continue;
      const unreachable = await this.unreachable(pull);

      await insertWatcher(this.store.db, {
        id: randomUUID(),
        profileId,
        sessionId,
        ...pull,
        status: unreachable ? 'unreachable' : 'watching',
        endedReason: unreachable ?? null,
        nextPollAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /**
   * Why the App cannot read `pull`, or undefined when it can, or when GitHub did not answer:
   * the first look finds out then. Without the App on that account nothing can be read, and
   * it is said once rather than tried every minute.
   */
  private async unreachable(pull: PullRef): Promise<string | undefined> {
    if (!this.github) return 'GitHub is not connected to this gateway.';
    try {
      const answer = await this.github.repoRequest(pull.owner, `/repos/${pull.owner}/${pull.repo}`);
      if (!answer) return `The Jian GitHub App is not installed on ${pull.owner}.`;
      if (answer.status === 404)
        return `The Jian GitHub App cannot reach ${pull.owner}/${pull.repo}.`;
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** A head the agent pushed itself: its change is not someone else's. */
  async pushed(profileId: string, repository: string, branch: string, sha: string) {
    const [owner, repo] = repository.split('/');
    if (!owner || !repo || !/^[0-9a-f]{40}$/i.test(sha)) return;
    await rememberOwnPush(this.store.db, profileId, {
      owner,
      repo,
      branch,
      sha: sha.toLowerCase(),
    });
  }

  /** Looks at every watcher whose time has come. */
  async lookDue(): Promise<void> {
    if (!this.github) return;
    const now = new Date(this.clock());
    for (const watcher of await dueWatchers(this.store.db, now, PER_TICK)) {
      // Moved past the next tick before the look, so no other worker takes it meanwhile.
      const claimed = await claimWatcher(
        this.store.db,
        watcher,
        new Date(now.getTime() + WATCH_EVERY_MS),
      );
      if (!claimed) continue;
      try {
        await this.look(claimed, this.github);
      } catch (error) {
        console.error(
          `jian: pull request ${watcher.owner}/${watcher.repo}#${watcher.number} could not be looked at`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  private async look(watcher: PullWatcher, github: WatchGitHub) {
    const now = new Date(this.clock());
    const pull: PullRef = { owner: watcher.owner, repo: watcher.repo, number: watcher.number };
    const url = `https://github.com/${pull.owner}/${pull.repo}/pull/${pull.number}`;
    const before = watcher.state as WatchState;
    const read = await lookAt(github.repoRequest, pull, before);

    if ('kind' in read) return this.failed(watcher, pull, url, read, now);

    const { changes, state, ended } = compare(before, read.look, {
      ...(await appLogin(github)),
      ownShas: watcher.ownShas,
    });
    const next: WatchState = { ...state, etags: read.etags };
    const endedBy = ended
      ? changes.some((change) => change.kind === 'merged')
        ? 'merged'
        : 'closed'
      : undefined;

    // Judged before the transaction: Jev reads its settings and counts its use on the store's own
    // connection, and on a single-connection store (the desktop app's) that read waits for the
    // transaction, which waits for it, and every other request waits behind both.
    const note = changes.length
      ? await this.marked(
          changeNote(pull, changes, { url, ...(endedBy ? { ended: endedBy } : {}) }),
          changes,
        )
      : undefined;

    await this.store.transaction(watcher.profileId, async (tx) => {
      const saved = await saveWatcher(
        tx,
        watcher,
        {
          state: next,
          failingSince: null,
          ...(endedBy ? { status: 'ended', endedReason: endedBy } : {}),
        },
        now,
      );
      // Another worker looked since: what it found is the one told.
      if (!saved || note === undefined) return;
      await this.tell(tx, watcher, note, changes);
    });
  }

  /** A look that found nothing: wait, and give up after a day of failing, saying so once. */
  private async failed(
    watcher: PullWatcher,
    pull: PullRef,
    url: string,
    failure: LookFailure,
    now: Date,
  ) {
    const since = watcher.failingSince ?? now;
    const lost =
      failure.kind === 'unreachable' &&
      (!(watcher.state as WatchState).started ||
        now.getTime() - since.getTime() >= GIVE_UP_AFTER_MS);
    const givesUp =
      lost || (failure.kind === 'failed' && now.getTime() - since.getTime() >= GIVE_UP_AFTER_MS);

    if (givesUp) {
      const reason = 'reason' in failure ? failure.reason : 'GitHub kept refusing.';
      await this.store.transaction(watcher.profileId, async (tx) => {
        const saved = await saveWatcher(
          tx,
          watcher,
          { status: 'unreachable', endedReason: reason, failingSince: since },
          now,
        );
        // The agent heard of it only if it was watching it: one that never got a look is the
        // panel's to say, not a turn.
        if (saved && (watcher.state as WatchState).started) {
          await this.tell(tx, watcher, lostNote(pull, url, reason), []);
        }
      });
      return;
    }

    const failures = Math.max(
      1,
      Math.round((now.getTime() - since.getTime()) / WATCH_EVERY_MS) + 1,
    );
    const wait =
      failure.kind === 'limited'
        ? failure.retryAfterMs
        : Math.min(WATCH_EVERY_MS * 2 ** Math.min(failures, 4), LONGEST_WAIT_MS);
    await saveWatcher(
      this.store.db,
      watcher,
      { failingSince: since, nextPollAt: new Date(now.getTime() + wait) },
      now,
    );
  }

  /**
   * Starts the conversation's turn on the note, in the background: the agent reads it, the
   * conversation does not show it. Keyed by what changed, so a look repeated after a crash
   * finds the turn it already started.
   */
  private async tell(tx: Store['db'], watcher: PullWatcher, note: string, changes: Change[]) {
    const key = createHash('sha256')
      .update(`${watcher.version}:${JSON.stringify(changes)}:${note}`)
      .digest('hex')
      .slice(0, 32);
    const run = await this.runs.submit(
      watcher.profileId,
      watcher.sessionId,
      { text: note, requestKey: `pull-watch:${watcher.id}:${key}` },
      { transaction: tx, purpose: 'resume' },
    );
    // In the transaction: on the desktop app's one connection a read outside it waits for it.
    await this.deliveries?.deliverRun(watcher.profileId, watcher.sessionId, run.id, tx);
  }

  /** What others wrote may address the agent: a note that does gets the warning on top. */
  private async marked(note: string, changes: Change[]) {
    const quotes = changes.some((change) => change.kind === 'review' || change.kind === 'comment');
    if (!this.judge || !quotes) return note;
    const checked = await markSteering(this.judge, note).catch(() => note);
    return typeof checked === 'string'
      ? checked
      : `${(checked as { warning: string }).warning}\n\n${note}`;
  }
}

async function appLogin(github: WatchGitHub) {
  const login = await github.appLogin().catch(() => undefined);
  return login ? { appLogin: login } : {};
}

/** Whether an MCP answer says the call failed. */
const failed = (result: unknown) =>
  Boolean(
    result && typeof result === 'object' && (result as { isError?: unknown }).isError === true,
  );

function refOf(url: string): PullRef | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}
