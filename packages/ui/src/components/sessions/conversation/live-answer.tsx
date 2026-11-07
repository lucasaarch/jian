'use client';

import type { RunProgress } from '@jian/contracts';
import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Run, ToolStep } from '../../../lib/api';
import { Markdown } from '../../ui/markdown';
import { cleanText } from '../message';
import { LiveThought } from '../progress';
import { type ConversationState, useConversation } from './store';
import { answers, turnOf } from './turns';
import { useSmoothText } from './use-smooth-text';

/** Whose turn a live row follows: this conversation's, or the other agent's answering it. */
export type Side = 'self' | 'call';

/**
 * What a turn is doing now. Its own turn's progress comes with the stream into `live`; the other
 * agent's comes with each read of its run.
 */
function progressOf(state: ConversationState, runId: string | undefined, side: Side) {
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
 * The text a turn is writing, as it should show: none while a tool runs, and none once it is a
 * stored message of that turn. A message can be read before the progress that wrote it is
 * cleared, and the same words must not show twice. Cleaned as a stored answer is, so the text
 * revealed so far is always the start of the answer it becomes: a trailing break kept on one
 * side only would make the answer restart from blank as it lands.
 */
function writtenOf(state: ConversationState, runId: string | undefined, side: Side) {
  const progress = progressOf(state, runId, side);
  if (!progress?.text || progress.phase === 'tool') return '';
  const text = cleanText(progress.text);
  return stored(state, runId, text) ? '' : text;
}

/**
 * A turn with nothing of its own to show: its words were just handed to the answer they became
 * and the stream has said nothing since, or what it is writing is already a stored answer.
 * Drawing it would flash a working line under an answer that just ended. Anything newer, such
 * as a paragraph released while a tool's input is written, shows the working line again.
 */
export function spentOf(state: ConversationState, runId: string | undefined, side: Side) {
  const progress = progressOf(state, runId, side);
  if (!progress) return false;
  if (side === 'self' && state.live?.handed) return true;
  const text = progress.phase === 'tool' ? '' : cleanText(progress.text);
  return Boolean(text) && stored(state, runId, text);
}

/**
 * An answer's text, with what its turn is writing now after it. The same element draws the text
 * as it streams and once it is stored, so the reveal goes on from where it was when the answer
 * lands. Only text this element showed live is revealed: a stored answer, or a line that joined
 * it without being written here, draws whole. Only this redraws as the text grows.
 */
export function LiveAnswer({
  said = '',
  runId,
  side = 'self',
}: {
  /** What is stored of the answer, cleaned for drawing. */
  said?: string;
  /** The turn whose writing follows what is stored: the live row's, or the answer it joins. */
  runId?: string;
  side?: Side;
}) {
  const live = useConversation((state) => writtenOf(state, runId, side));
  const text = live && said ? `${said}\n\n${live}` : live || said;
  // Whether this element has shown text as it was written, since it was drawn.
  const lived = useRef(false);
  if (live) lived.current = true;
  // What shows whole. Until something is written here, all of it; after, what stood before the
  // writing began, unless the answer changed into something else rather than grew.
  const settled = useRef(said);
  if (!lived.current || !text.startsWith(settled.current)) settled.current = text;
  const tail = text.slice(settled.current.length);
  const revealed = useSmoothText(tail, true);
  const shown = settled.current + revealed;
  const streaming = Boolean(live) || revealed.length < tail.length;
  if (!shown) return null;

  return (
    <div className={`chat-text markdown${streaming ? ' streaming' : ''}`}>
      <Markdown text={shown} breaks streaming={streaming} />
    </div>
  );
}

/**
 * The working line of a turn at work, with the tools since it last said something. It reads
 * only what the line shows from the progress, so the text growing never draws it again.
 */
export function LiveWork({
  runId,
  side,
  status,
  createdAt,
  steps,
  startedAt,
}: {
  runId?: string;
  side: Side;
  status: Run['status'];
  createdAt: string;
  steps: ToolStep[];
  startedAt: string;
}) {
  const unfinished = steps.length > 0 && !steps.at(-1)?.finishedAt;
  const now = useConversation(
    useShallow((state) => {
      const progress = progressOf(state, runId, side);
      return {
        phase: progress?.phase,
        tool: progress?.tool,
        server: progress?.mcp?.server,
        serverTool: progress?.mcp?.tool,
        writing: Boolean(progress?.text),
        // A settled line stops its clock at the last word only when no tool ended after it.
        updatedAt: progress?.text && unfinished ? progress.updatedAt : undefined,
      };
    }),
  );
  const progress: RunProgress | undefined = now.phase && {
    phase: now.phase,
    ...(now.tool ? { tool: now.tool } : {}),
    ...(now.server && now.serverTool ? { mcp: { server: now.server, tool: now.serverTool } } : {}),
    // Whether text is under way is all the line needs of it: the words are LiveAnswer's.
    text: now.writing ? '…' : '',
    steps: 0,
    updatedAt: now.updatedAt ?? createdAt,
  };

  return <LiveThought run={{ status, createdAt, progress }} steps={steps} startedAt={startedAt} />;
}
