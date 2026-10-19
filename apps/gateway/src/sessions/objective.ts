import type { SessionObjective } from '@jian/contracts';
import { sessionObjectiveSchema } from '@jian/contracts';

/** Cap on auto-follow-ups for one open objective before the gateway asks the owner. */
export const MAX_OBJECTIVE_CONTINUATIONS = 25;

export type ObjectiveCommand =
  | { action: 'set'; text: string }
  | { action: 'done' }
  | { action: 'cancel' };

/**
 * Standalone owner commands, same shape as `/ponytail` and `/caveman`.
 * `/objective <text>` sets work; `/objective done` and `/done` finish it;
 * `/objective cancel` and `/cancel objective` drop it.
 */
export function parseObjectiveCommand(text: string): ObjectiveCommand | undefined {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower === '/objective done' || lower === '/done') return { action: 'done' };
  if (lower === '/objective cancel' || lower === '/cancel objective') return { action: 'cancel' };
  const match = trimmed.match(/^\/objective(?:\s+|:)(.+)$/is);
  if (!match?.[1]) return undefined;
  const body = match[1].trim();
  if (!body || body.toLowerCase() === 'done' || body.toLowerCase() === 'cancel') return undefined;
  return { action: 'set', text: body.slice(0, 2000) };
}

/** Short chat noise must not become a durable objective. */
const ACK =
  /^(ok|okay|yes|no|thanks|thank you|continua|continue|go on|sim|n[aã]o|nao|please|pls)\.?$/iu;

/**
 * Whether a fresh user message should seed an objective when none is open.
 * Mode and objective commands are handled separately.
 */
export function shouldSeedObjective(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 40) return false;
  if (ACK.test(trimmed)) return false;
  if (parseObjectiveCommand(trimmed)) return false;
  return true;
}

export function objectiveAt(
  text: string,
  status: SessionObjective['status'],
  at: string,
  extras: { continuations?: number; note?: string } = {},
): SessionObjective {
  return sessionObjectiveSchema.parse({
    text: text.slice(0, 2000),
    status,
    updatedAt: at,
    continuations: extras.continuations ?? 0,
    ...(extras.note ? { note: extras.note } : {}),
  });
}
