import type { RemoteResult, RemoteTask } from '@jian/contracts';

/**
 * What a task may run past its own limit before the worker gives up on it, in ms. Every kind
 * stops itself at that limit; this is longer than a command takes to be killed and drained.
 */
const TASK_GRACE_MS = 10_000;

/** A task that did not answer, in the shape its kind is read in by the gateway. */
function unanswered(task: RemoteTask, message: string, timedOut: boolean): RemoteResult {
  return {
    taskId: task.id,
    exitCode: null,
    stdout: '',
    stderr: message,
    timedOut,
    ...(task.kind === 'computer' ? { computer: { ok: false, error: message } } : {}),
    ...(task.kind === 'browser' ? { browser: { error: message } } : {}),
  };
}

/**
 * Runs a task so that it always answers: the worker runs one at a time, so one that never settles
 * would stop this machine from polling, and it would read as offline until someone restarted it.
 */
export async function withinTaskLimit(
  task: RemoteTask,
  execute: (task: RemoteTask) => Promise<RemoteResult>,
  graceMs = TASK_GRACE_MS,
): Promise<RemoteResult> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<RemoteResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          unanswered(task, 'The task did not finish in time, and may still be running.', true),
        ),
      task.timeoutMs + graceMs,
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(() => execute(task)), late]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unanswered(task, `The task failed: ${message}`.slice(0, 2000), false);
  } finally {
    clearTimeout(timer);
  }
}
