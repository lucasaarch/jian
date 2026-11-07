'use client';

import type { RunProgress } from '@jian/contracts';
import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Run, ToolStep } from '../../../lib/api';
import { Markdown } from '../../ui/markdown';
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

/**
 * The text a turn is writing, as it should show: none while a tool runs, and none once it is a
 * stored message of that turn. A message can be read before the progress that wrote it is
 * cleared, and the same words must not show twice.
 */
function writtenOf(state: ConversationState, runId: string | undefined, side: Side) {
  const progress = progressOf(state, runId, side);
  if (!progress?.text || progress.phase === 'tool') return '';
  const text = progress.text.trim();
  const stored = state.messages.some(
    (message) => answers(message) && turnOf(message) === runId && message.content.trim() === text,
  );
  return stored ? '' : progress.text;
}

/**
 * A turn whose words were all handed to the answer they became, with nothing new since: its live
 * row has nothing to say. Drawing it would flash a working line under an answer that just ended.
 */
export const spentOf = (state: ConversationState, runId: string | undefined, side: Side) =>
  progressOf(state, runId, side)?.phase === 'writing' && !writtenOf(state, runId, side);

/**
 * An answer's text, with what its turn is writing now after it. The same element draws the text
 * as it streams and once it is stored, so the reveal goes on from where it was when the answer
 * lands: what was on screen whole when it was first drawn shows at once, and only what came
 * after is revealed. Only this redraws as the text grows.
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
  // A stored answer that changed into something else, rather than grew, shows whole at once.
  const settled = useRef(said);
  if (!text.startsWith(settled.current)) settled.current = text;
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
