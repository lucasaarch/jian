import type { AgentRuntime } from '../agent/runtime.js';
import type { Store } from '../storage/database.js';
import type { Work } from '../tasks/service.js';
import type { RunExecutor } from './executors.js';
import type { RunRecovery } from './port.js';
import { listQueuedRuns, listUnreportedSubagents } from './repository.js';

/**
 * Finds the runs that are due — queued ones, after recovering any a dead worker left — and sends
 * them to its executor. The same on a server and in the desktop app; only the executor differs.
 */
export class RunQueue {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private executor: RunExecutor,
    private services: {
      lifecycle: RunRecovery;
      store: Store;
      work: Pick<Work, 'reportWorker'>;
    },
    private runtime: AgentRuntime,
    private report: (message: string) => void = console.error,
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
