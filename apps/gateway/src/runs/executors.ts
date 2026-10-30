import type { PgBoss } from 'pg-boss';

/** Runs one queued run to its end. */
export type Execute = (profileId: string, runId: string) => Promise<void>;

/**
 * Where queued runs go to be executed. The queue decides which runs are due; an executor only
 * runs what it is sent, each run once however often it is sent.
 */
export interface RunExecutor {
  start(execute: Execute): Promise<void>;
  send(profileId: string, runId: string): Promise<void>;
  stop(): Promise<void>;
}

const queueName = 'jian-agent-runs';

/** Across every worker of a server installation, through pg-boss in its PostgreSQL. */
export class BossExecutor implements RunExecutor {
  constructor(
    private readonly boss: PgBoss,
    private readonly report: (message: string) => void = console.error,
  ) {}

  async start(execute: Execute): Promise<void> {
    this.boss.on('error', () => this.report('jian: queue connection failed'));
    await this.boss.start();

    // Run leases handle recovery; queue retries must not replay an agent's external effects.
    await this.boss.createQueue(queueName, {
      policy: 'exclusive',
      retryLimit: 0,
      expireInSeconds: 660,
    });

    await this.boss.work<{ profileId: string; runId: string }>(
      queueName,
      { localConcurrency: 4, batchSize: 1, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) {
          await execute(job.data.profileId, job.data.runId);
        }
      },
    );
  }

  async send(profileId: string, runId: string): Promise<void> {
    await this.boss.send(queueName, { profileId, runId }, { singletonKey: runId });
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 15_000 });
  }
}

/**
 * Inside this process alone: a gateway that runs on one computer for one owner, such as the
 * desktop app's, has no other worker to share runs with and no pg-boss to share them through.
 */
export class LocalExecutor implements RunExecutor {
  private execute?: Execute;
  private readonly running = new Map<string, Promise<void>>();
  private readonly waiting: { profileId: string; runId: string }[] = [];
  private stopped = false;

  /** Runs at once, as the server executor's local concurrency. */
  constructor(private readonly concurrency = 4) {}

  async start(execute: Execute): Promise<void> {
    this.execute = execute;
    this.stopped = false;
  }

  async send(profileId: string, runId: string): Promise<void> {
    if (this.running.has(runId) || this.waiting.some((run) => run.runId === runId)) return;
    this.waiting.push({ profileId, runId });
    this.next();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.waiting.length = 0;
    await Promise.allSettled(this.running.values());
  }

  private next(): void {
    while (!this.stopped && this.execute && this.running.size < this.concurrency) {
      const run = this.waiting.shift();
      if (!run) return;
      const execute = this.execute;
      const done = execute(run.profileId, run.runId)
        .catch(() => {})
        .finally(() => {
          this.running.delete(run.runId);
          this.next();
        });
      this.running.set(run.runId, done);
    }
  }
}
