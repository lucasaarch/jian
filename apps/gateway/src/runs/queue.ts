import type { AgentRuntime } from '../agent/runtime.js';
import type { Store } from '../storage/database.js';
import type { Work } from '../tasks/service.js';
import type { RunExecutor } from './executors.js';
import type { RunRecovery } from './port.js';
import { listQueuedRuns, listUnreportedSubagents, writeQueued } from './repository.js';

/** How long every slot may stay held, with runs waiting, before the gateway's log says so. */
export const FULL_WARNING_MS = 60_000;

/**
 * Finds the runs that are due — queued ones, after recovering any a dead worker left — and sends
 * them to its executor. The same on a server and in the desktop app; only the executor differs.
 */
export class RunQueue {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();
  /** Since when every slot has been held with runs waiting, and whether the log was told. */
  private full?: { since: number; warned: boolean };

  constructor(
    private executor: RunExecutor,
    private services: {
      lifecycle: RunRecovery;
      store: Store;
      work: Pick<Work, 'reportWorker'>;
    },
    private runtime: Pick<AgentRuntime, 'execute' | 'liveOwners' | 'stop'>,
    private report: (message: string) => void = console.error,
    private clock: () => number = Date.now,
  ) {}

  async start() {
    await this.executor.start((profileId, runId) => this.runtime.execute(profileId, runId));
    await this.tick();
  }

  private async dispatch() {
    await this.services.lifecycle.recover(this.runtime.liveOwners());

    for (const worker of await listUnreportedSubagents(this.services.store.db, 100)) {
      if (this.stopped) return;
      await this.services.work
        .reportWorker(worker.profileId, worker.id)
        .catch(() => this.report(`jian: subagent ${worker.id} handoff failed; will retry`));
    }

    const queued = await listQueuedRuns(this.services.store.db, 1000);

    for (const run of queued) {
      if (this.stopped) {
        return;
      }

      await this.executor.send(run.profileId, run.id);
    }

    await this.tellWaiting(queued.map((run) => run.id));
  }

  /**
   * Queued runs this worker cannot start yet say so in their progress, with how many runs hold
   * the slots, or the panel shows them as starting for as long as the wait lasts and the owner
   * takes the gateway for broken. With several workers one that is full may tell a run another
   * is about to take; that one's claim clears it a second later.
   */
  private async tellWaiting(queued: string[]) {
    const { working, slots } = this.executor.load();
    const now = this.clock();

    if (working < slots || !queued.length) {
      this.full = undefined;
      return;
    }

    await writeQueued(
      this.services.store.db,
      queued,
      { working, slots },
      new Date(now).toISOString(),
    );
    this.full ??= { since: now, warned: false };

    if (!this.full.warned && now - this.full.since >= FULL_WARNING_MS) {
      this.full.warned = true;
      this.report(
        `jian: all ${slots} run slots have been busy for over a minute, with ${queued.length} ${queued.length === 1 ? 'run' : 'runs'} waiting; JIAN_RUN_CONCURRENCY raises the limit`,
      );
    }
  }

  private async tick() {
    if (this.stopped) {
      return;
    }

    this.pending = this.dispatch().catch(() =>
      this.report('jian: run dispatch failed; will retry'),
    );

    await this.pending;

    if (!this.stopped) {
      this.timer = setTimeout(() => {
        void this.tick();
      }, 2000);

      this.timer.unref();
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.runtime.stop();
    await this.pending;
    await this.executor.stop();
  }
}
