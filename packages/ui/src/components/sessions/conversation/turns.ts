import type { Message, Run } from '../../../lib/api';

/**
 * Who answers a message: the agent, or — on a question this profile carried to another agent —
 * that agent, whose run is kept in its own profile.
 */
export const answers = (message: Message) =>
  message.call ? message.role === 'user' : message.role === 'assistant';
export const turnOf = (message: Message) => message.call?.runId ?? message.runId;
/** A person's own line in a turn: the one that opened it, or one sent while it ran. */
export const toldTurn = (message: Message) =>
  message.role === 'user' && !message.call && !message.purpose && Boolean(message.runId);

/**
 * What was just read, joined to what is already known. A new line pushes the oldest out of the
 * latest page, and it stays: the reader has it on screen, and earlier pages end right above it.
 * What was read that does not meet what is known starts over, since keeping both would hide a
 * gap in the conversation behind what looks like a whole one.
 */
export function joinHistory<Item extends { id: string }>(known: Item[], latest: Item[]): Item[] {
  const first = latest[0];
  if (!first) return [];
  const meets = known.findIndex((item) => item.id === first.id);

  return meets < 0 ? latest : [...known.slice(0, meets), ...latest];
}

/**
 * Whether two reads of the same JSON say the same thing. Compares every field, nested ones too,
 * so a reaction or a channel detail added to a message counts as a change. Key order is ignored:
 * a kept snapshot and a fresh read need not list fields alike.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;

  return keys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** A message read again unchanged: the known object is kept, so its row is not drawn again. */
export const sameMessage = (known: Message, read: Message) => sameValue(known, read);

/** What a read says of each turn it asked about, over what was known of the others. */
export function overTurns<Value>(
  known: Map<string, Value>,
  asked: string[],
  read: [string, Value][],
) {
  const next = new Map(known);
  for (const turn of asked) next.delete(turn);
  for (const [turn, value] of read) next.set(turn, value);

  return next;
}

/** How a run ends: its tools and its question can no longer change. */
const ENDED = new Set<Run['status']>(['completed', 'failed', 'interrupted', 'cancelled']);
export const ended = (status: Run['status']) => ENDED.has(status);

/**
 * The turns of a page whose tools are final, by the profile's recent runs as the gateway listed
 * them before the tools were read. A turn missing from the list is ended when it began before the
 * oldest run listed: the list holds the latest ones, so it is older than all of them. One missing
 * and newer started after the list was read, and is not.
 */
export function endedTurns(turns: string[], page: Message[], recent: Run[]): string[] {
  const listed = new Map(recent.map((item) => [item.id, item.status]));
  const oldest = recent.map((item) => item.createdAt).sort()[0];

  return turns.filter((turn) => {
    const status = listed.get(turn);
    if (status) return ENDED.has(status);
    const began = page.find((message) => message.runId === turn)?.createdAt;
    return Boolean(oldest && began && began < oldest);
  });
}
