import type { ProtectionMode, RunApproval } from '@jian/contracts';
import { isChatChannel } from '../channels/kinds.js';

/**
 * Where an action lands: a change on the machine, a change in an outside service the owner
 * connected, or words and files reaching someone else. Reading, searching and answering are
 * not actions, and never ask.
 */
export type ActionKind = 'machine' | 'service' | 'message';

/** The gateway's own tools that act outside the conversation, by where they land. */
export const ACTION_KINDS: Partial<Record<string, ActionKind>> = {
  run_command: 'machine',
  run_remote_command: 'machine',
  remote_computer: 'machine',
  pull_remote_file: 'machine',
  push_remote_file: 'machine',
  write_file: 'machine',
  edit_file: 'machine',
  send_file: 'message',
  send_session_message: 'message',
  message_contact: 'message',
  ask_agent: 'message',
};

/**
 * An MCP tool acts on a service the owner connected, whatever that service is. One that its
 * server declares read-only is not an action: it changes nothing, and asking would slow every
 * lookup. The declaration is the server's word, and the server is one the owner chose.
 */
export function mcpActionKind(tool: unknown): ActionKind | undefined {
  const annotations = (tool as { metadata?: { annotations?: { readOnlyHint?: unknown } } })
    ?.metadata?.annotations;

  return annotations?.readOnlyHint === true ? undefined : 'service';
}

/**
 * What a run does with an action, settled once when it starts. `pause` parks the run until a
 * person who may approve decides; `decline` answers the agent at once, because nobody who
 * could approve is reachable from where it is; `guard` runs it unless the guardrail finds it
 * catastrophic; `run` lets actions through.
 */
export type Protection =
  | { mode: 'run' }
  | { mode: 'pause' }
  | { mode: 'guard' }
  | { mode: 'decline'; reason: string };

export const NO_APPROVER =
  'Not run: nobody in this conversation may approve actions. Say what you would do and that the owner has to allow it, either by letting someone here approve or by giving this conversation full access.';

export const SUBAGENT_ASKS =
  'Not run: this conversation asks before acting, and only the agent that sent you can ask. Report what you would do, with the exact command, file or message, so it can ask for approval.';

/**
 * The protection of a run. A subagent acts under the conversation that sent it, never its own
 * task session; a chat channel can only ask a contact the owner allowed to approve, and every
 * other conversation is approved by the owner from the panel.
 */
export function protectionFor(input: {
  /** The protection of the conversation the action would happen in, or that sent the subagent. */
  mode: ProtectionMode;
  subagent: boolean;
  channel: string;
  /** Whether the contact of a chat channel conversation may approve; ignored elsewhere. */
  contactCanApprove: boolean;
}): Protection {
  if (input.mode === 'full') return { mode: 'run' };
  // Auto waits for nobody, so a subagent and a channel's contact act under it as the chat does.
  if (input.mode === 'auto') return { mode: 'guard' };
  if (input.subagent) return { mode: 'decline', reason: SUBAGENT_ASKS };
  if (isChatChannel(input.channel) && !input.contactCanApprove) {
    return { mode: 'decline', reason: NO_APPROVER };
  }

  return { mode: 'pause' };
}

/** The call that parked a run, as the agent made it. */
export type PausedCall = { toolName: string; toolCallId: string; kind: ActionKind; input: unknown };

/** Thrown from a guarded action so the runtime parks the run instead of failing the tool. */
export class ApprovalPause extends Error {
  constructor(readonly call: PausedCall) {
    super('Waiting for approval');
    this.name = 'ApprovalPause';
  }
}

const REQUEST_CHARS = 4000;

/** The call as JSON, cut where it would outgrow the record; never parsed back. */
export function requestText(input: unknown): string {
  const text = JSON.stringify(input ?? null, null, 2) ?? 'null';

  return text.length > REQUEST_CHARS ? `${text.slice(0, REQUEST_CHARS - 1)}…` : text;
}

/** One argument of a call, as text, when it is there and is text. */
const field = (input: unknown, name: string): string | undefined => {
  const value =
    input && typeof input === 'object' ? (input as Record<string, unknown>)[name] : undefined;

  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

/**
 * What a card says for each kind of action when the model could not write it: what it does in
 * plain words, and the one argument a person checks before saying yes, never the raw call.
 */
const PLAIN: Record<
  string,
  (input: unknown) => { title: string; detail?: string; confirm: string }
> = {
  run_command: (input) => ({
    title: 'Run a command',
    detail: field(input, 'command'),
    confirm: 'Run',
  }),
  run_remote_command: (input) => ({
    title: 'Run a command on a connected machine',
    detail: field(input, 'command'),
    confirm: 'Run',
  }),
  remote_computer: (input) => ({
    title: 'Use a connected computer',
    detail: [field(input, 'action'), field(input, 'text') ?? field(input, 'key')]
      .filter(Boolean)
      .join(': '),
    confirm: 'Approve',
  }),
  write_file: (input) => ({
    title: 'Write a file',
    detail: field(input, 'path'),
    confirm: 'Write',
  }),
  edit_file: (input) => ({ title: 'Edit a file', detail: field(input, 'path'), confirm: 'Edit' }),
  pull_remote_file: (input) => ({
    title: 'Copy a file from a connected machine',
    detail: field(input, 'path'),
    confirm: 'Copy',
  }),
  push_remote_file: (input) => ({
    title: 'Copy a file to a connected machine',
    detail: field(input, 'path'),
    confirm: 'Copy',
  }),
  send_file: (input) => ({ title: 'Send a file', detail: field(input, 'path'), confirm: 'Send' }),
  send_session_message: (input) => ({
    title: 'Send a message',
    detail: field(input, 'text'),
    confirm: 'Send',
  }),
  message_contact: (input) => ({
    title: 'Send a message',
    detail: field(input, 'text'),
    confirm: 'Send',
  }),
  ask_agent: (input) => ({
    title: 'Ask another agent',
    detail: field(input, 'text'),
    confirm: 'Ask',
  }),
};

const KINDS: Record<ActionKind, string> = {
  machine: 'Change the machine',
  service: 'Use a connected service',
  message: 'Send a message',
};

/**
 * What a card says when the model could not write it. A connected service's tool is named by
 * its server and its own name, which the call's exposed name only abbreviates.
 */
export function plainDescription(
  call: Pick<PausedCall, 'toolName' | 'kind' | 'input'>,
  service?: { server: string; tool: string },
) {
  const known = PLAIN[call.toolName]?.(call.input);
  const title =
    known?.title ?? (service ? `Use ${service.server}'s ${service.tool}` : KINDS[call.kind]);
  const detail = known
    ? (known.detail ?? '')
    : (() => {
        // An unknown tool: its first few text arguments, as name and value.
        const input = call.input && typeof call.input === 'object' ? call.input : {};
        return Object.entries(input as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'string' && value.trim())
          .slice(0, 3)
          .map(([name, value]) => `${name}: ${String(value).trim()}`)
          .join('\n');
      })();

  return {
    title: title.slice(0, 140),
    detail: detail.length > 600 ? `${detail.slice(0, 599)}…` : detail,
    confirmLabel: known?.confirm ?? 'Approve',
  };
}

/** The approval as a line of history: what the conversation shows wherever there is no card. */
export function approvalText(approval: Pick<RunApproval, 'title' | 'detail'>): string {
  return [`Waiting for approval: ${approval.title}`, approval.detail].filter(Boolean).join('\n');
}

const RESULT_CHARS = 6000;

/**
 * The turn a decision starts. An approved call has already run when the model reads this, and
 * its result is handed over beside it; the model is told so, so it does not ask or run it again.
 */
export function approvalResumePrompt(approval: RunApproval): string {
  const who = approval.decidedBy === 'contact' ? 'They' : 'The owner';

  return approval.decision === 'approved'
    ? [
        `${who} approved the action you asked to take: ${approval.title}.`,
        'It has already run, exactly as you called it; its result follows. Continue the work from it. Do not ask again and do not run it a second time.',
      ].join('\n')
    : [
        `${who} rejected the action you asked to take: ${approval.title}.`,
        'It did not run. Do not try it another way without asking.',
        ...(approval.note ? [`What they said: ${approval.note}`] : []),
      ].join('\n');
}

/** The approved call's outcome, as the model reads it, cut to a size a turn can carry. */
export function approvedOutcome(outcome: unknown): string {
  const text = JSON.stringify(outcome ?? null) ?? 'null';
  const bounded = text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS - 1)}…` : text;

  return `Result of the approved action:\n${bounded}`;
}
