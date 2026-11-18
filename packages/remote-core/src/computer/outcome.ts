import type {
  RemoteComputerDelivery,
  RemoteComputerErrorCode,
  RemoteComputerPermission,
  RemoteComputerResult,
  RemoteResult,
} from '@jian/contracts';

/** A result before it is tied to its task. */
export type ActionOutcome = Omit<RemoteResult, 'taskId'>;

/**
 * What a failure was and whether it reached the screen. `not_delivered` means nothing was sent,
 * so repeating the action is safe; `uncertain` means part of it may have landed.
 */
export type Failure = {
  code: RemoteComputerErrorCode;
  delivery: RemoteComputerDelivery;
  permission?: RemoteComputerPermission;
};

/** What is assumed of a failure nobody classified: the screen may have been touched. */
const UNCLASSIFIED: Failure = { code: 'failed', delivery: 'uncertain' };

/** An error that says what kind of failure it is. A plain `Error` reads as unclassified. */
export class ActionError extends Error {
  readonly failure: Failure;

  constructor(message: string, failure: Failure) {
    super(message);
    this.failure = failure;
  }
}

/** Refused before anything was sent to the screen. */
export const refused = (message: string, code: RemoteComputerErrorCode = 'invalid_args') =>
  new ActionError(message, { code, delivery: 'not_delivered' });

export function failureOf(error: unknown): Failure {
  return error instanceof ActionError ? error.failure : UNCLASSIFIED;
}

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
export function failed(message: string, failure: Failure = UNCLASSIFIED): ActionOutcome {
  return {
    exitCode: 1,
    stdout: '',
    stderr: message,
    timedOut: false,
    computer: { ok: false, error: message, ...failure },
  };
}

/**
 * The outcome as the gateway that asked can read it. Its result schema is strict, so one from
 * before `code`, `delivery` and `permission` would refuse the whole result: they go only to a
 * gateway that sent `protocol: 2`.
 */
export function forProtocol(outcome: ActionOutcome, protocol: number | undefined): ActionOutcome {
  if (protocol === 2 || !outcome.computer) return outcome;
  const { code: _code, delivery: _delivery, permission: _permission, ...legacy } = outcome.computer;
  return { ...outcome, computer: legacy };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
