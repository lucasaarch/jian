import type { RemoteComputerResult, RemoteResult } from '@jian/contracts';

/** A result before it is tied to its task. */
export type ActionOutcome = Omit<RemoteResult, 'taskId'>;

export function succeeded(
  computer: Omit<RemoteComputerResult, 'ok'> = {},
  output: { stdout?: string; stderr?: string } = {},
): ActionOutcome {
  return {
    exitCode: 0,
    stdout: output.stdout ?? '',
    stderr: output.stderr ?? '',
    timedOut: false,
    computer: { ok: true, ...computer },
  };
}

/** The message goes to both places: the agent reads `computer.error`, the log reads stderr. */
export function failed(message: string): ActionOutcome {
  return {
    exitCode: 1,
    stdout: '',
    stderr: message,
    timedOut: false,
    computer: { ok: false, error: message },
  };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
