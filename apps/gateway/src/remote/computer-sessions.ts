/**
 * Several conversations driving one machine's screen: whose turn it is, and how each one's
 * pointer is told apart.
 *
 * The worker runs one action at a time, so nothing overlaps. But an agent works in bursts — look,
 * click, type — with seconds of thought between the steps, and served strictly oldest first,
 * two agents would alternate step by step: each click moving the focus the other was about to
 * type into. So the conversation that acted last keeps the screen while it keeps acting, and
 * another one cuts in only once it has waited long enough. All of it is read from the tasks
 * themselves; nothing is held in memory or locked.
 */

/**
 * How long after its last action a conversation still holds the screen, in ms: longer than a
 * model usually takes between two steps, short enough that one that stopped is not waited for.
 */
export const TURN_GAP_MS = 10_000;

/**
 * How long another conversation waits behind the one holding the screen before it is served
 * anyway, in ms. It has to stay well under the 30 seconds `waitForTask` allows a task beyond its
 * own time limit, or the wait alone would fail it.
 */
export const TURN_MAX_WAIT_MS = 20_000;

type Queued = { kind: string | null; payload: unknown; createdAt: Date };

/** The conversation a computer task belongs to; none from a worker that keeps no sessions. */
function sessionOf(task: { kind: string | null; payload: unknown }): string | null {
  if (task.kind !== 'computer' || typeof task.payload !== 'object' || task.payload === null) {
    return null;
  }
  const { session } = task.payload as { session?: { id?: unknown } };
  return typeof session?.id === 'string' ? session.id : null;
}

/**
 * The conversation holding the screen: the one whose computer task was handed out or answered
 * last, unless that was long ago or it said it was done.
 */
export function turnHolder(
  last: { kind: string | null; payload: unknown; updatedAt: Date } | undefined,
  now: number,
): string | null {
  if (!last || now - last.updatedAt.getTime() > TURN_GAP_MS) return null;
  if ((last.payload as { action?: unknown } | null)?.action === 'end_session') return null;
  return sessionOf(last);
}

/**
 * The first task, oldest first, that may run now. Only a computer task of another conversation
 * ever waits; shell, files and the rest do not touch the screen and keep their order.
 */
export function nextInTurn<T extends Queued>(
  queued: T[],
  holder: string | null,
  now: number,
): T | undefined {
  return queued.find((task) => {
    const session = sessionOf(task);
    return (
      !holder ||
      !session ||
      session === holder ||
      now - task.createdAt.getTime() >= TURN_MAX_WAIT_MS
    );
  });
}

/**
 * The pointer colours conversations are told apart by. The first is agent-desktop's accent;
 * the rest are as far from it and from each other as eight hues get, and all read on the dark
 * rim the pointer is drawn with.
 */
const POINTER_COLORS = [
  '#4299ff',
  '#ff6b5e',
  '#34c77b',
  '#b57bff',
  '#ff9f2e',
  '#19c2d1',
  '#ff5fa8',
  '#e5c02b',
] as const;

/**
 * The agent's name as its pointer's label: short enough for a tag beside a pointer, and cut
 * between characters, never inside one — half an emoji is not valid JSON to the helper.
 */
export function pointerLabel(name: string): string {
  let label = '';
  for (const char of name.trim()) {
    if (label.length + char.length > 40) break;
    label += char;
  }
  return label || 'Agent';
}

/** An agent's pointer colour: always the same for the same profile, with nothing stored. */
export function pointerColor(profileId: string): string {
  let hash = 0;
  for (const char of profileId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return POINTER_COLORS[hash % POINTER_COLORS.length] ?? POINTER_COLORS[0];
}
