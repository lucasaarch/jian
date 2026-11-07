import type { RunProgress } from '@jian/contracts';
import type { Message } from '../../../lib/api';
import { cleanText } from '../message';
import type { ConversationState } from './store';
import { answers, turnOf } from './turns';

/** What the turn at work is saying, as the store keeps it. */
export type Live = {
  runId: string;
  progress: RunProgress;
  /**
   * Its words were just handed to the answer they became, and nothing newer was told since:
   * the turn has nothing of its own to show until the stream speaks again.
   */
  handed?: true;
  /**
   * Paragraphs the stream stopped showing before a read brought them back as messages, oldest
   * first, as they were last told. The gateway releases each paragraph as a message and empties
   * or restarts its draft at once; the message is read a moment later. Shown until then, so a
   * paragraph never leaves the screen between the two.
   */
  held?: string[];
};

/**
 * The longest text a progress frame carries: past it, a frame holds the tail and its start moves
 * on as the answer grows.
 */
const PROGRESS_CHARS = 8000;
/** How much of the text told before a tail must find again in the next to be the same answer. */
const TAIL_OVERLAP = 200;

/**
 * Whether the text told now goes on from what was told before, rather than replacing it. A frame
 * that empties or restarts the text means the gateway released what came before as a message.
 */
function continues(before: string, now: string) {
  if (now.startsWith(before)) return true;
  // A capped frame slides: its start is gone, but what ended the last one is still in it.
  return (
    before.length >= PROGRESS_CHARS &&
    now.length >= PROGRESS_CHARS &&
    now.includes(before.slice(-TAIL_OVERLAP))
  );
}

/**
 * The live line after the stream told `progress` of `runId`: text that stops going on from what
 * was shown keeps what was shown, held, until the message it became is read.
 */
export function advance(known: Live | undefined, runId: string, progress: RunProgress): Live {
  if (known?.runId !== runId) return { runId, progress };
  const before = known.progress.text;
  const held =
    before.trim() && !continues(before, progress.text)
      ? [...(known.held ?? []), before]
      : known.held;

  return held?.length ? { runId, progress, held } : { runId, progress };
}

/** Whether the stream told text that stopped going on from what was on screen. */
export const released = (known: Live | undefined, next: Live) =>
  (next.held?.length ?? 0) > (known?.runId === next.runId ? (known.held?.length ?? 0) : 0);

/** Whether a stored answer is the text shown, whole or as it stood when last told. */
const becomes = (message: Message, text: string) => {
  const shown = cleanText(text);
  const said = cleanText(message.content);
  return Boolean(shown) && said.startsWith(shown);
};

/**
 * What a read that brought new messages does to the live line. Each held paragraph, and the text
 * under way, goes to the answer it became, matched by content: the answer read is the text shown,
 * whole or grown since. The first answer that matched takes the live row's key, so the element
 * that showed the text as it came is the one that keeps it, and the live row moves on to a new
 * key. A text that matched nothing stays: a message read in the same breath may be one the stream
 * never showed.
 */
export function handover(
  live: Live | undefined,
  known: Message[],
  messages: Message[],
): { live: Live; taker: Message } | undefined {
  if (!live) return undefined;
  const ids = new Set(known.map((message) => message.id));
  const landed = messages.filter(
    (message) => answers(message) && turnOf(message) === live.runId && !ids.has(message.id),
  );
  const held = [...(live.held ?? [])];
  const current = live.progress.text;
  let taker: Message | undefined;
  let spoken = false;

  for (const message of landed) {
    const at = held.findIndex((text) => becomes(message, text));
    if (at >= 0) held.splice(at, 1);
    else if (!spoken && becomes(message, current)) spoken = true;
    else continue;
    taker ??= message;
  }
  if (!taker) return undefined;

  return {
    taker,
    live: {
      runId: live.runId,
      // The words under way became the answer: the line has nothing of its own until told more.
      progress: spoken ? { ...live.progress, text: '' } : live.progress,
      ...(spoken && !held.length ? { handed: true as const } : {}),
      ...(held.length ? { held } : {}),
    },
  };
}

/** Whose turn a live row follows: this conversation's, or the other agent's answering it. */
export type Side = 'self' | 'call';

/**
 * What a turn is doing now. Its own turn's progress comes with the stream into `live`; the other
 * agent's comes with each read of its run.
 */
export function progressOf(state: ConversationState, runId: string | undefined, side: Side) {
  if (!runId) return undefined;
  if (side === 'call') return state.callRun?.id === runId ? state.callRun.progress : undefined;
  return state.live?.runId === runId ? state.live.progress : undefined;
}

/** Whether a turn's answer already holds these words, cleaned as `said` is. */
const stored = (state: ConversationState, runId: string | undefined, text: string) =>
  state.messages.some(
    (message) =>
      answers(message) && turnOf(message) === runId && cleanText(message.content) === text,
  );

/**
 * Each piece of text a turn shows, cleaned: the paragraphs held for their messages, then what it
 * is writing, which a tool at work empties.
 */
function piecesOf(state: ConversationState, runId: string | undefined, side: Side) {
  const progress = progressOf(state, runId, side);
  if (!progress) return [];
  const held = side === 'self' ? (state.live?.held ?? []) : [];
  const now = progress.phase === 'tool' ? '' : progress.text;
  return [...held, now].map(cleanText).filter(Boolean);
}

/**
 * The text a turn is writing, as it should show: the paragraphs held until their messages are
 * read, then what is under way, and none of it once it is a stored message of that turn. A
 * message can be read before the progress that wrote it is cleared, and the same words must not
 * show twice. Cleaned as a stored answer is, so the text revealed so far is always the start of
 * the answer it becomes: a trailing break kept on one side only would make the answer restart
 * from blank as it lands.
 */
export function writtenOf(state: ConversationState, runId: string | undefined, side: Side) {
  return piecesOf(state, runId, side)
    .filter((text) => !stored(state, runId, text))
    .join('\n\n');
}

/**
 * A turn with nothing of its own to show: its words were just handed to the answer they became
 * and the stream has said nothing since, or all it shows is already a stored answer. Drawing it
 * would flash a working line under an answer that just ended. Anything newer, such as a
 * paragraph released while a tool's input is written, shows the working line again.
 */
export function spentOf(state: ConversationState, runId: string | undefined, side: Side) {
  if (!progressOf(state, runId, side)) return false;
  if (side === 'self' && state.live?.handed) return true;
  const pieces = piecesOf(state, runId, side);
  return pieces.length > 0 && pieces.every((text) => stored(state, runId, text));
}
