import type { RemoteResult, RemoteTask } from '@jian/contracts';
import type { Logger } from './log.ts';
import { postResult } from './result.ts';
import { executeShellTask } from './shell.ts';
import type { WorkerStateFile } from './state.ts';
import { describeTask } from './task.ts';
import { compatibilityError, fetchGatewayVersion } from './version.ts';

/** What a worker needs to reach its gateway as one machine. */
export type WorkerConfig = { gateway: string; machineId: string; token: string };
/** How the screen stands, as the gateway is told: a Mac knows; elsewhere it is unknown. */
export type UiState = () => string;

/** How long the worker waits between empty polls, and the ceiling of its backoff, in ms. */
const IDLE_MS = 1000;
const BACKOFF_CEILING_MS = 60_000;

/** Runs a task: Computer Use on this screen, or a command in this machine's shell. */
export async function executeTask(task: RemoteTask): Promise<RemoteResult> {
  if (task.kind === 'computer') {
    const { executeComputerTask } = await import('./computer/index.ts');
    return executeComputerTask(task);
  }
  return executeShellTask(task);
}

/** The capabilities this machine offers beside the shell: Computer Use, when its helper works. */
export async function detectCapabilities(): Promise<string[]> {
  try {
    const { probeComputerCapability, computerCapabilityName } = await import('./computer/index.ts');
    const name = computerCapabilityName();
    return name && (await probeComputerCapability()) ? [name] : [];
  } catch {
    // Computer Use unavailable until its helper is ready; shell tasks still work.
    return [];
  }
}

/** What the gateway is told on every request: who this worker is and what it can do. */
export function workerHeaders({
  token,
  version,
  capabilities,
  uiState,
}: {
  token: string;
  version: string;
  capabilities: string[];
  uiState: UiState;
}): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'x-jian-platform': `${process.platform}-${process.arch}`,
    'x-jian-remote-version': version,
    'x-jian-remote-ui-state': uiState(),
    ...(capabilities.length ? { 'x-jian-remote-capabilities': capabilities.join(',') } : {}),
  };
}

/** Where this machine's worker routes are on its gateway. */
export const workerBase = (config: WorkerConfig) =>
  `${config.gateway}/v1/remote/worker/${config.machineId}`;

/**
 * Tells the gateway this worker is stopping, so the panel shows the machine offline at once
 * instead of when its last poll grows old. Brief and best effort: a stop must not hang on it.
 */
export async function sayGoodbye(config: WorkerConfig, headers: Record<string, string>) {
  await fetch(`${workerBase(config)}/disconnect`, {
    method: 'POST',
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}

/**
 * How a host updates its worker when the gateway asks: the CLI reinstalls its npm package, a
 * native app would run its own updater. It answers with the result to post, and `restart`,
 * run once the gateway has it, to start over on the new release.
 */
export type Updater = (
  task: RemoteTask,
) => Promise<{ result: RemoteResult; restart?: () => Promise<void> }>;

/**
 * A worker connected to its gateway: it polls for tasks, runs each, and posts what came of it,
 * backing off while the gateway is away. The host brings what is its own — the credentials, the
 * log and the state it keeps, and `update` when it can update itself — and stops it with
 * `signal`. A worker on another release than its gateway still connects: the gateway then hands
 * it nothing but its update.
 */
export async function runWorker({
  config,
  version,
  log,
  state,
  capabilities,
  uiState = () => 'unknown',
  execute = executeTask,
  update,
  signal,
}: {
  config: WorkerConfig;
  version: string;
  log: Logger;
  state: WorkerStateFile;
  capabilities: string[];
  uiState?: UiState;
  execute?: (task: RemoteTask) => Promise<RemoteResult>;
  update?: Updater;
  signal?: AbortSignal;
}): Promise<void> {
  const headers = () => workerHeaders({ token: config.token, version, capabilities, uiState });
  const base = workerBase(config);
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const gatewayVersion = await fetchGatewayVersion(config.gateway).catch(() => undefined);
  state.update({ gatewayVersion, capabilities });
  log.info('Connected', {
    gateway: config.gateway,
    worker: version,
    gatewayVersion,
    capabilities: capabilities.join(','),
  });
  const mismatch = compatibilityError(version, gatewayVersion);
  if (mismatch) log.warn(`${mismatch} Until then agents cannot use this machine.`);
  let failures = 0;

  while (!signal?.aborted) {
    try {
      const response = await fetch(`${base}/tasks/next`, {
        headers: headers(),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 502 || response.status === 503) {
        throw new Error(`poll failed: HTTP ${response.status} (gateway temporarily unavailable)`);
      }
      if (!response.ok) throw new Error(`poll failed: HTTP ${response.status}`);
      if (failures > 0) log.info('Reconnected', { gateway: config.gateway });
      failures = 0;
      state.contact();
      const { task } = (await response.json()) as { task: RemoteTask | null };
      if (!task) {
        await pause(IDLE_MS);
        continue;
      }
      const action = describeTask(task);
      log.info('Task started', { task: task.id, ...action });
      const startedAt = Date.now();
      const { result, restart } =
        task.kind === 'update' ? await runUpdate(task, update) : { result: await execute(task) };
      const durationMs = Date.now() - startedAt;
      const ok = action.kind === 'computer' ? result.computer?.ok !== false : result.exitCode === 0;
      state.ran(action.kind, ok, durationMs);
      log[ok ? 'info' : 'warn']('Task finished', {
        task: task.id,
        kind: action.kind,
        ok,
        exitCode: result.exitCode,
        timedOut: result.timedOut || undefined,
        durationMs,
        error: result.computer?.error,
      });
      // Retry the result rather than rerunning the command after a transient network error.
      await postResult(base, headers(), result, log);
      // Only once the gateway knows how the update went: the new release takes over from here.
      if (restart) {
        log.info('Restarting on the new release');
        await restart();
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lost(message);
      failures += 1;
      log.error('Poll failed', { error: message, attempt: failures });
      const wait = Math.random() * Math.min(BACKOFF_CEILING_MS, 1000 * 2 ** Math.min(failures, 6));
      log.warn('Retrying', { inSeconds: (wait / 1000).toFixed(1), attempt: failures });
      await pause(wait);
    }
  }
}

/** An update task, on a host that has no way to update itself, fails with what to do instead. */
async function runUpdate(
  task: RemoteTask,
  update: Updater | undefined,
): Promise<{ result: RemoteResult; restart?: () => Promise<void> }> {
  if (update) return update(task);
  return {
    result: {
      taskId: task.id,
      exitCode: 1,
      stdout: '',
      stderr: 'This Jian Remote cannot update itself; update it where it was installed.',
    },
  };
}
