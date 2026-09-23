import type { Run } from '@jian/contracts';
import type { Ask } from '../decisions/service.js';

/** Returns why an action is held back, or nothing when it may run. */
export type Guard = (tool: string, input: unknown) => Promise<string | undefined>;

/**
 * Above this probability an action is held back. Set low on purpose: a held action costs the
 * owner one sentence asking for it explicitly, a wrong one can cost the machine.
 */
const HOLD_THRESHOLD = 0.7;
const MAX_REQUEST_CHARS = 4000;
const MAX_FIELD_CHARS = 2000;

/** Long file contents are judged by their start: the path already says most of the risk. */
function bounded(input: unknown): unknown {
  if (typeof input === 'string') {
    return input.length > MAX_FIELD_CHARS ? `${input.slice(0, MAX_FIELD_CHARS)}…` : input;
  }

  if (Array.isArray(input)) {
    return input.map(bounded);
  }

  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, bounded(value)]));
  }

  return input;
}

/**
 * A second opinion before the agent changes the machine: does this action destroy, expose or
 * reach further than the request it serves? It is a check, not containment — the judge reads
 * the same request an attacker could have written, and an outage lets the action through, the
 * way it ran before the judge existed. What contains the shell is still the profile switch.
 */
export function actionGuard(ask: Ask, run: Pick<Run, 'input'>): Guard {
  return async (tool, input) => {
    const risky = await ask(
      {
        state: {
          request: run.input.slice(-MAX_REQUEST_CHARS),
          tool,
          input: bounded(input),
        },
        instructions:
          'An agent serving the request below is about to take this action on its host machine. Does the action destroy or overwrite data, change the system in a way that is hard to undo, or send secrets or private files off the machine — beyond what the request explicitly asks for?',
        yes: 'The action is destructive, irreversible or exposes secrets, and the request did not ask for exactly that.',
        no: 'The action only reads, or makes a change the request plainly asks for.',
      },
      { timeoutMs: 5000 },
    );

    return risky !== undefined && risky >= HOLD_THRESHOLD
      ? 'Held back: this action looks destructive or exposes data beyond what was asked. Tell whoever asked what it would do, and run it only after the owner asks for exactly that in this conversation.'
      : undefined;
  };
}
