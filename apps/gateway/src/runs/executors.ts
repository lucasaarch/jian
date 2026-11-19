import type { PgBoss } from 'pg-boss';
import { z } from 'zod';

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
  /** The runs this worker is executing now, and how many it executes at once. */
  load(): RunLoad;
}

export type RunLoad = { working: number; slots: number };

const queueName = 'jian-agent-runs';

/**
 * How many runs one worker executes at once, unless `JIAN_RUN_CONCURRENCY` says otherwise. A
 * turn spends its time waiting on a model or a tool, not on this process, and a parent waiting
 * for its subagents holds its place while they need theirs: at four, one conversation with a few
 * subagents left every other turn queued for minutes, and at sixteen six subagents stuck on a
 * spent usage limit, their parents and a few schedules did the same.
 *
 * What a slot costs while it is held: the turn's history and tool results in memory, a few
 * megabytes for most and tens for one with a million-token context, and one process for each
 * command-line MCP server the agent connects, for the turn's whole life. A browser or a shell
 * lives only as long as the tool call that opened it, so it does not count. 48 leaves room for
 * three times the morning above; a small machine whose agents use several command-line MCP
 * servers may want fewer. Idle, pg-boss polls once a second for each slot, one indexed query.
 */
export const RUN_CONCURRENCY = 48;

/**
 * `JIAN_RUN_CONCURRENCY` as the gateway reads it: empty is the default, as compose passes an
 * unset variable. 256 at most, past which the idle polling alone is a steady load on PostgreSQL.
 */
export const runConcurrencySchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.coerce.number().int().min(1).max(256).default(RUN_CONCURRENCY),
);

/**
 * How a run's job is held in pg-boss. A turn has no clock of its own (a waiting
 * `spawn_subagent` call alone may hold one for 15 minutes), and pg-boss fails a job whose
 * handler outlives `expireInSeconds`: the run would go on under its own lease, but the job
 * would leave `localConcurrency` and another would take its slot. Six hours is above any turn
 * that is working; what ends a turn is its lease, its budgets and the stall watchdog. The
 * heartbeat, which pg-boss refreshes on its own while the handler runs, is what notices a worker
 * that died.
 *
 * A turn waiting out a model it cannot reach may pass six hours, since those calls are retried
 * without end (`agent/model-retry.ts`), and pg-boss caps `expireInSeconds` at 24 hours.
 * Expiry does not end it: pg-boss fails the job and stops waiting for the handler, but never stops
 * the handler, which ignores `job.signal`. The turn keeps its lease, renewed by the runtime's own
 * pulse, so recovery leaves it alone and it finishes as any other; only its concurrency slot is
 * freed early. A run's truth is its row and its lease, never its job (`retryLimit: 0` already
 * keeps pg-boss from replaying one), so nothing re-queues it either.
 */
export const RUN_QUEUE_OPTIONS = {
  policy: 'exclusive',
  // Run leases handle recovery; queue retries must not replay an agent's external effects.
  retryLimit: 0,
  expireInSeconds: 6 * 60 * 60,
  heartbeatSeconds: 60,
} as const;

/** Across every worker of a server installation, through pg-boss in its PostgreSQL. */
export class BossExecutor implements RunExecutor {
  /** Handlers running now; pg-boss hands out no more than `concurrency` of them. */
  private working = 0;

  constructor(
    private readonly boss: PgBoss,
    private readonly report: (message: string) => void = console.error,
    private readonly concurrency = RUN_CONCURRENCY,
  ) {}

  load(): RunLoad {
    return { working: this.working, slots: this.concurrency };
  }

  async start(execute: Execute): Promise<void> {
    this.boss.on('error', () => this.report('jian: queue connection failed'));
    await this.boss.start();

    // `createQueue` leaves a queue that exists as it was: an installation that made it with the
    // earlier options is brought to these by `updateQueue`, which cannot change the policy.
    await this.boss.createQueue(queueName, RUN_QUEUE_OPTIONS);
    const { policy: _policy, ...settings } = RUN_QUEUE_OPTIONS;
    await this.boss.updateQueue(queueName, settings);

    await this.boss.work<{ profileId: string; runId: string }>(
      queueName,
      { localConcurrency: this.concurrency, batchSize: 1, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) {
          this.working += 1;
          try {
            await execute(job.data.profileId, job.data.runId);
          } finally {
            this.working -= 1;
          }
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
  constructor(private readonly concurrency = RUN_CONCURRENCY) {}

  async start(execute: Execute): Promise<void> {
    this.execute = execute;
    this.stopped = false;
  }

  load(): RunLoad {
    return { working: this.running.size, slots: this.concurrency };
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
