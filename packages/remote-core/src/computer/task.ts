import type { RemoteResult, RemoteTask } from '@jian/contracts';
import { type ActionOutcome, failed, forProtocol } from './outcome.ts';
import type { ComputerSession } from './session.ts';

const DEFAULT_TIMEOUT_MS = 30_000;

const TIMED_OUT =
  'Computer action timed out. It was stopped, and part of it may have reached the screen: take a screenshot before going on.';

/**
 * Runs one task on a session within its time limit. Always resolves with a result, so the
 * worker posts something and the gateway task never waits on its own timeout instead.
 */
export async function runComputerTask(
  session: ComputerSession,
  task: RemoteTask,
): Promise<RemoteResult> {
  const { computer } = task;
  if (!computer) {
    return { taskId: task.id, ...forProtocol(failed('Computer task missing action.'), undefined) };
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ActionOutcome>((resolve) => {
    timer = setTimeout(() => {
      // Answering alone would leave the helper at it: a stuck action could still press
      // something after the agent was told it had failed, under whatever came next.
      session.abort(TIMED_OUT);
      resolve({
        ...failed(TIMED_OUT, { code: 'timeout', delivery: 'uncertain' }),
        exitCode: null,
        timedOut: true,
      });
    }, task.timeoutMs || DEFAULT_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([session.runAction(computer), timeout]);
    return { taskId: task.id, ...forProtocol(outcome, computer.protocol) };
  } finally {
    clearTimeout(timer);
  }
}
