'use client';

import type { OrbState } from 'thinking-orbs';
import type { Message, Profile, Run, ToolStep } from '../../lib/api';
import { Markdown } from '../ui/markdown';
import { RefineFrame } from '../ui/refine-frame';
import { AgentLine } from './conversation/agent-line';
import { drawnBox } from './media';
import { ThoughtLine } from './thought-line';
import { toolLabel } from './tool-labels';
import { traceOf } from './trace';

/** The orb's animation for each tool: looking things up, working with its hands, or asking. */
const toolOrbs: Record<string, OrbState> = {
  web_search: 'searching',
  fetch_url: 'searching',
  search_history: 'searching',
  search_files: 'searching',
  find_files: 'searching',
  ask_agent: 'connecting',
  list_agents: 'connecting',
  send_session_message: 'connecting',
  message_contact: 'connecting',
};

/**
 * What the agent is on, in a few words, and the orb that goes with it: the same in the list of
 * conversations and in the open one, since both read the same run.
 */
export function statusOf(run: Pick<Run, 'status' | 'progress'>): {
  label: string;
  state: OrbState;
  tool: boolean;
} {
  const progress = run.progress;
  const tool =
    progress?.phase === 'tool'
      ? progress.tool
        ? toolLabel(progress.tool, progress.mcp)
        : 'Using a tool'
      : undefined;

  return {
    label:
      run.status === 'queued' ? 'Starting' : tool ? tool : progress?.text ? 'Writing' : 'Thinking',
    state:
      run.status === 'queued'
        ? 'breathing'
        : tool
          ? (toolOrbs[progress?.tool ?? ''] ?? 'working')
          : 'composing',
    tool: Boolean(tool),
  };
}

/** The working Thought Line of a run and the pictures it is drawing so far. */
export function LiveThought({
  run,
  steps,
  startedAt,
}: {
  run: Pick<Run, 'status' | 'progress' | 'createdAt'>;
  steps: ToolStep[];
  startedAt: string;
}) {
  const { label, state, tool } = statusOf(run);
  const writing = !tool && Boolean(run.progress?.text);

  return (
    <>
      {(!writing || steps.length > 0) && (
        <ThoughtLine
          working={!writing}
          label={label}
          orb={state}
          steps={traceOf(steps)}
          startedAt={startedAt}
          finishedAt={writing ? (steps.at(-1)?.finishedAt ?? run.progress?.updatedAt) : undefined}
        />
      )}
      <ImageDrafts steps={steps} />
    </>
  );
}

/**
 * A frame for each picture the turn is drawing, where the answer will carry it. The finished
 * picture arrives with the answer and resolves in its own frame there.
 */
function ImageDrafts({ steps }: { steps: ToolStep[] }) {
  const drawing = steps.filter(
    (step) => step.toolName === 'generate_image' && step.status === 'running',
  );

  if (!drawing.length) return null;

  return (
    <div className="image-drafts">
      {drawing.map((step) => (
        <RefineFrame key={step.toolCallId} status="generating" {...drawnBox(step.aspectRatio)} />
      ))}
    </div>
  );
}

/**
 * Where a turn's tools go among what it said: each under the last line said before it began,
 * so the conversation reads in the order things happened. Tools from before the first line
 * head the turn. Both sides are stamped by the gateway's clock, and a line is written before
 * the tool it announces starts.
 */
export function placeSteps(steps: ToolStep[], said: Pick<Message, 'id' | 'createdAt'>[]) {
  const head: ToolStep[] = [];
  const after = new Map<string, ToolStep[]>();

  for (const step of steps) {
    const started = Date.parse(step.startedAt);
    const anchor = said.findLast((line) => Date.parse(line.createdAt) <= started);

    if (anchor) after.set(anchor.id, [...(after.get(anchor.id) ?? []), step]);
    else head.push(step);
  }

  return { head, after, first: said[0], last: said.at(-1) };
}

/**
 * The agent at work, at the end of the conversation: the Thought Line saying what it is on, with
 * the tools of this stretch beneath it, then the words as they are written. The panel is the
 * only surface that names tools; a chat channel gets the answer and nothing else.
 */
export function LiveTurn({
  run,
  agent,
  steps,
  startedAt = run.createdAt,
  children,
}: {
  run: Pick<Run, 'status' | 'progress' | 'createdAt'>;
  agent?: Pick<Profile, 'name' | 'avatar'>;
  /**
   * Only the tools since the last thing the turn said: the earlier ones already sit under the
   * words they followed, where they stay once the turn ends.
   */
  steps: ToolStep[];
  /** When the stretch this line covers began: the turn's start, or the last thing it said. */
  startedAt?: string;
  /** The agents this turn handed work to. */
  children?: React.ReactNode;
}) {
  const progress = run.progress;
  const { tool } = statusOf(run);
  // Writing is shown by the words themselves, drawn as the finished answer will be, so nothing
  // reflows when the run ends.
  const writing = !tool && Boolean(progress?.text);

  return (
    <AgentLine
      agent={agent}
      pending
      before={
        <>
          <LiveThought run={run} steps={steps} startedAt={startedAt} />
          {children}
        </>
      }
      text={
        writing ? (
          <div className="chat-text markdown streaming">
            <Markdown text={progress?.text ?? ''} breaks streaming />
          </div>
        ) : null
      }
    />
  );
}
