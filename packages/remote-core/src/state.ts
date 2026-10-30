import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TaskSummary } from './task.ts';

type TaskKind = TaskSummary['kind'];

/** How the running worker stands, as state.json keeps it for `status`. */
export type WorkerState = {
  pid: number;
  version: string;
  startedAt: string;
  connected: boolean;
  tasks: { total: number; failed: number } & Record<TaskKind, number>;
  gateway?: string;
  machineId?: string;
  platform?: string;
  gatewayVersion?: string | undefined;
  capabilities?: string[];
  lastContactAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  lastTask?: { kind: TaskKind; ok: boolean; durationMs: number; at: string };
  stoppedAt?: string;
};

export type WorkerStateFile = ReturnType<typeof createWorkerState>;

/**
 * How the running worker stands, kept in state.json for `status`: connection, versions, what
 * it ran. Written whole each time, small, and only by the worker that holds the lock.
 */
export function createWorkerState({
  path,
  version,
  now = () => new Date(),
}: {
  path: string;
  version: string;
  now?: () => Date;
}) {
  const state: WorkerState = {
    pid: process.pid,
    version,
    startedAt: now().toISOString(),
    connected: false,
    tasks: { total: 0, failed: 0, shell: 0, computer: 0, update: 0 },
  };
  let savedAt = 0;
  const save = (force: boolean) => {
    // Every poll touches lastContactAt; on disk it moves at most every few seconds.
    if (!force && Date.now() - savedAt < 5_000) return;
    savedAt = Date.now();
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, path);
    } catch {
      // `status` then shows the last state that could be written.
    }
  };
  return {
    state,
    update(patch: Partial<WorkerState>, force = true) {
      Object.assign(state, patch);
      save(force);
    },
    contact() {
      const was = state.connected;
      state.connected = true;
      state.lastContactAt = now().toISOString();
      save(!was);
    },
    lost(error: string) {
      state.connected = false;
      state.lastError = error;
      state.lastErrorAt = now().toISOString();
      save(true);
    },
    ran(kind: TaskKind, ok: boolean, durationMs: number) {
      state.tasks.total += 1;
      state.tasks[kind] += 1;
      if (!ok) state.tasks.failed += 1;
      state.lastTask = { kind, ok, durationMs, at: now().toISOString() };
      save(true);
    },
  };
}
