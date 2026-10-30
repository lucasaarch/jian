import type { RemoteResult, RemoteTask } from '@jian/contracts';
import { type ActionOutcome, failed } from './outcome.ts';
import type { ComputerSession } from './session.ts';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Runs one task on a session within its time limit. Always resolves with a result, so the
 * worker posts something and the gateway task never waits on its own timeout instead.
 */
export async function runComputerTask(
  session: ComputerSession,
  task: RemoteTask,
): Promise<RemoteResult> {
  if (!task.computer) return { taskId: task.id, ...failed('Computer task missing action.') };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ActionOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ ...failed('Computer action timed out'), exitCode: null, timedOut: true }),
      task.timeoutMs || DEFAULT_TIMEOUT_MS,
    );
  });
  try {
    return {
      taskId: task.id,
      ...(await Promise.race([session.runAction(task.computer), timeout])),
    };
  } finally {
    clearTimeout(timer);
  }
}
