'use client';

import type { OrbState } from 'thinking-orbs';
import type { Message, Profile, Run, ToolStep } from '../../lib/api';
import { Markdown } from '../ui/markdown';
import { RefineFrame } from '../ui/refine-frame';
import { CodeChanges } from './code-change';
import { drawnBox } from './media';
import { ChatSpeaker } from './message';
import { ThoughtLine, type ThoughtStep } from './thought-line';

/** What the panel calls each tool, so the owner reads an action instead of a function name. */
const toolLabels: Record<string, string> = {
  analyze_media: 'looking at an attachment',
  send_file: 'sending a file',
  save_attachment: 'saving an attachment',
  compact_context: 'compacting its context',
  load_tools: 'loading tools',
  generate_image: 'drawing an image',
  generate_speech: 'recording a voice reply',
  list_speech_voices: 'choosing a voice',
  create_checkpoint: 'saving its progress',
  read_memories: 'reading its memories',
  remember: 'saving a memory',
  forget_memory: 'deleting a memory',
  list_schedules: 'checking its schedules',
  create_schedule: 'scheduling something',
  update_schedule: 'changing a schedule',
  delete_schedule: 'deleting a schedule',
  link_memories: 'linking memories',
  unlink_memories: 'unlinking memories',
  list_sessions: 'looking through its conversations',
  read_session: 'reading another conversation',
  load_skill: 'loading a skill',
  search_history: 'searching the history',
  read_artifact: 'reading a large result',
  list_activities: 'checking what is under way',
  read_run_checkpoints: 'reviewing the steps of a run',
  send_session_message: 'writing to another conversation',
  list_agents: 'looking up the other agents',
  ask_agent: 'asking another agent',
  read_inbox: 'reading its inbox',
  acquire_resource: 'reserving a resource',
  release_resource: 'releasing a resource',
  message_contact: 'writing to a contact',
  list_contacts: 'looking up its contacts',
  run_command: 'running a command',
  read_file: 'reading a file',
  edit_file: 'editing a file',
  write_file: 'writing a file',
  find_files: 'finding files',
  search_files: 'searching files',
  list_directory: 'listing a directory',
  web_search: 'searching the web',
  fetch_url: 'reading a page',
  create_skill: 'writing a skill',
  update_skill: 'rewriting a skill',
  delete_skill: 'removing a skill',
  update_identity: 'adjusting its own identity',
  read_identity: 'rereading its own identity',
  create_profile: 'creating an agent',
  throw_confetti: 'throwing confetti',
  spawn_subagent: 'handing work to an agent',
  ask_jev: 'asking Jev',
  ask_user: 'asking you',
};

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
      ? (toolLabels[progress.tool ?? ''] ?? progress.tool ?? 'using a tool')
      : undefined;

  return {
    label:
      run.status === 'queued'
        ? 'Starting'
        : tool
          ? `${tool[0]?.toUpperCase()}${tool.slice(1)}`
          : progress?.text
            ? 'Writing'
            : 'Thinking',
    state:
      run.status === 'queued'
        ? 'breathing'
        : tool
          ? (toolOrbs[progress?.tool ?? ''] ?? 'working')
          : 'composing',
    tool: Boolean(tool),
  };
}

const failures: Partial<Record<ToolStep['status'], string>> = {
  failed: 'Failed',
  refused: 'Refused by the server',
  uncertain: 'Outcome unknown',
  stopped: 'Did not finish',
};

/** The tools of a turn as the Thought Line's trace, in the words the panel uses for them. */
export function traceOf(steps: ToolStep[]): ThoughtStep[] {
  return steps.map((step) => {
    const label = toolLabels[step.toolName] ?? step.toolName.replaceAll('_', ' ');
    const failed = failures[step.status];

    return {
      key: step.toolCallId,
      text: `${label[0]?.toUpperCase()}${label.slice(1)}`,
      status: step.status === 'running' ? 'running' : failed ? 'failed' : 'done',
      ...(failed ? { note: failed, ...(step.error ? { detail: step.error } : {}) } : {}),
    };
  });
}

/** The working Thought Line of a run and the files it has changed so far. */
function LiveThought({
  run,
  steps,
  startedAt,
}: {
  run: Run;
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
      <CodeChanges steps={steps} fresh />
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

  return { head, after, last: said.at(-1) };
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
  run: Run;
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
    <article className="chat-line pending theirs" aria-live="polite">
      <div className="chat-author-row">
        <ChatSpeaker agent={agent} />
      </div>
      <LiveThought run={run} steps={steps} startedAt={startedAt} />
      {children}
      {writing && (
        <div className="chat-text markdown streaming">
          <Markdown text={progress?.text ?? ''} breaks streaming />
        </div>
      )}
    </article>
  );
}
