'use client';

import type { RunProgress } from '@jian/contracts';
import { useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Run, ToolStep } from '../../../lib/api';
import { Markdown } from '../../ui/markdown';
import { LiveThought } from '../progress';
import { progressOf, type Side, writtenOf } from './live-text';
import { useConversation } from './store';
import { useSmoothText } from './use-smooth-text';

/**
 * An answer's text, with what its turn is writing now after it. The same element draws the text
 * as it streams and once it is stored, so the reveal goes on from where it was when the answer
 * lands. Only text written while this element was on screen is revealed: a stored answer, a
 * line that joined it without being written here, and what was written before it was drawn all
 * show whole. Only this redraws as the text grows.
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
  const lived = useRef(Boolean(live));
  if (live) lived.current = true;
  // What shows whole. Until something is written here, all of it; after, what stood before the
  // writing began, unless the answer changed into something else rather than grew. What was
  // already written when it was drawn, as when a conversation opens mid-answer, counts as
  // standing: only what is written after that is revealed.
  const settled = useRef(text);
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
