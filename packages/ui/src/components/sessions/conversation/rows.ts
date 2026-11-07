import type { Message, Run, RunApproval, RunQuestion, Subagent, ToolStep } from '../../../lib/api';
import type { Outgoing } from '../../../lib/stores/outbox';
import { placeCrew, reportOf } from '../crew';
import { type DisplayMessage, groupMessages } from '../group-messages';
import { placeSteps } from '../progress';
import { running } from '../status';
import { liveRows } from './rows-live';
import type { ConversationState } from './store';
import { answers, toldTurn, turnOf } from './turns';

/** When a stretch of work began and ended, as ISO times; either may be unknown. */
export type Span = { startedAt?: string; finishedAt?: string };

/**
 * One thing drawn in the conversation, keyed so the element that drew it stays while it does.
 * A row rebuilt from a turn nothing touched holds the same values, so `sameRow` lets it be.
 */
export type Row =
  | {
      kind: 'message';
      key: string;
      /** The message, or the agent's consecutive lines joined into one answer. */
      message: Message;
      /** The last line joined into `message`, which the work after it follows. */
      lastMessage: Message;
      previous?: Message;
      /** The tools the turn used before this, its first line. */
      head?: ToolStep[];
      headSpan?: Span;
      /** A line sent while the turn was at work: its `head` is a line of its own above it. */
      steered: boolean;
      /** Agents spawned before this line was written, drawn above it. */
      crewBefore: Subagent[];
      /**
       * The turn at work is writing what will join this answer once stored: the row draws the
       * writing after itself, in place of a live row, so the paragraph never moves when it lands.
       */
      liveTail: boolean;
      /** Never drawn before: the only rows that animate in. */
      fresh: boolean;
      /** The aspect ratio of an image the turn drew, so its frame holds before it loads. */
      drawn?: string;
    }
  | {
      kind: 'approval';
      key: string;
      runId: string;
      approval: RunApproval;
      head?: ToolStep[];
      headSpan?: Span;
      crewBefore: Subagent[];
      fresh: boolean;
    }
  | {
      kind: 'question';
      key: string;
      runId: string;
      question: RunQuestion;
      head?: ToolStep[];
      headSpan?: Span;
      crewBefore: Subagent[];
      fresh: boolean;
    }
  | { kind: 'work'; key: string; steps: ToolStep[]; startedAt?: string; finishedAt?: string }
  | { kind: 'changes'; key: string; runId: string; steps: ToolStep[] }
  | { kind: 'crew'; key: string; agents: Subagent[] }
  | { kind: 'outgoing'; key: string; item: Outgoing }
  | {
      kind: 'live';
      key: string;
      /** None while a sent message is not a turn yet: the agent is drawn starting. */
      runId?: string;
      /** This conversation's own turn, or the other agent's while it answers a question. */
      side: 'self' | 'call';
      status: Run['status'];
      createdAt: string;
      /** Only the tools since the turn last said something. */
      steps: ToolStep[];
      /** When the stretch `steps` covers began: the turn's start, or its last line. */
      startedAt: string;
      crew: Subagent[];
    };

export type RowsInput = Pick<
  ConversationState,
  | 'messages'
  | 'tools'
  | 'asks'
  | 'callTools'
  | 'run'
  | 'callRun'
  | 'subagents'
  | 'keys'
  | 'liveSerial'
  | 'awaited'
> & {
  outgoing: Outgoing[];
  sessionId: string;
  /** The row keys already drawn: the first build of a page and an earlier page count as seen. */
  seen: ReadonlySet<string>;
  /** The turn at work has text under way. Only whether, never the text, so text builds nothing. */
  writing: boolean;
};

export type Placed = ReturnType<typeof placeSteps>;

const sameItems = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((item, at) => item === b[at]);

/**
 * Whether a row rebuilt says what the one drawn said. Values compare by identity, as the store
 * keeps what a read did not change; arrays a build makes anew compare item by item, and the
 * head's span, rebuilt every time, by its two times.
 */
export function sameRow(a: Row, b: Row): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;

  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((field) => {
    const one = left[field];
    const other = right[field];
    if (one === other) return true;
    if (Array.isArray(one) && Array.isArray(other)) return sameItems(one, other);
    if (field !== 'headSpan' || !one || !other) return false;
    const [x, y] = [one as Span, other as Span];
    return x.startedAt === y.startedAt && x.finishedAt === y.finishedAt;
  });
}

/**
 * The answer joined from several lines, by its first line: the same object while the lines are,
 * so the row of a turn nothing touched is not drawn again for a join made anew.
 */
const joins = new WeakMap<Message, { sources: Message[]; message: Message }>();

function steady({ message, index, lastIndex }: DisplayMessage, messages: Message[]) {
  const first = messages[index];
  if (!first || message === first) return message;
  const sources = messages.slice(index, lastIndex + 1);
  const known = joins.get(first);
  if (known && sameItems(known.sources, sources)) return known.message;
  joins.set(first, { sources, message });

  return message;
}

/**
 * What each row asks of the whole page, read once: where each turn's lines start and end, and
 * the last place each kind of line appears, so no row looks through the lines after it.
 */
function survey(messages: Message[]) {
  const spans = new Map<string, Span>();
  const lastAnswer = new Map<string, number>();
  const lastAssistant = new Map<string, number>();
  const lastUser = new Map<string, number>();

  messages.forEach((message, at) => {
    const turn = turnOf(message);
    if (turn) {
      const span = spans.get(turn);
      spans.set(turn, {
        startedAt: span?.startedAt ?? message.createdAt,
        finishedAt: message.createdAt,
      });
      if (answers(message)) lastAnswer.set(turn, at);
    }
    if (!message.runId) return;
    (message.role === 'assistant' ? lastAssistant : lastUser).set(message.runId, at);
  });

  return { spans, lastAnswer, lastAssistant, lastUser };
}

/**
 * A line the owner sent while a turn was already at work joins that turn, and divides its work
 * as the agent's own lines do: what was done before it stays above it, what came after below.
 */
function steersOf(messages: Message[]) {
  const opened = new Set<string>();
  const sent = new Set<string>();
  for (const message of messages) {
    if (!toldTurn(message) || !message.runId) continue;
    if (opened.has(message.runId)) sent.add(message.id);
    else opened.add(message.runId);
  }

  return sent;
}

/** Each turn's tools among the lines it said, so the work shows up as it was spoken. */
function placeTurns(input: RowsInput, steers: Set<string>) {
  const said = new Map<string, { lines: Message[]; call: boolean }>();
  for (const message of input.messages) {
    const turn = turnOf(message);
    if (!turn || !(answers(message) || steers.has(message.id))) continue;
    const known = said.get(turn) ?? { lines: [], call: Boolean(message.call) };
    known.lines.push(message);
    said.set(turn, known);
  }

  return new Map(
    [...said].map(([turn, { lines, call }]): [string, Placed] => [
      turn,
      placeSteps((call ? input.callTools : input.tools).get(turn) ?? [], lines),
    ]),
  );
}

/** The last question this profile carried to another agent, while its answer has not come. */
function pendingCall(messages: Message[]) {
  const last = messages.filter((message) => message.call && message.role === 'assistant').at(-1);
  const call = last?.call;
  if (!call) return undefined;

  return messages.some((message) => message.role === 'user' && message.call?.runId === call.runId)
    ? undefined
    : call;
}

/** The files a settled turn changed, only when it changed any. */
const changed = (steps: ToolStep[]) =>
  steps.some((step) => step.status === 'done' && Boolean(step.diff));

/**
 * The last line of the conversation when the text the turn at work is writing will join it once
 * stored, by the rule `groupMessages` joins lines by: an answer of that turn with nothing after
 * it that divides answers, no tools, no agent spawned, no card. Undefined when the writing will
 * stand on its own.
 */
function hostOf(
  { writing, run, asks }: RowsInput,
  last: Message | undefined,
  placed: Map<string, Placed>,
  tail: Map<string, Subagent[]>,
) {
  if (!writing || !run || !running(run) || !last) return undefined;
  if (last.role !== 'assistant' || last.call || last.purpose || last.runId !== run.id) {
    return undefined;
  }
  const asked = asks.get(run.id);
  const divided =
    Boolean(placed.get(run.id)?.after.get(last.id)?.length) ||
    Boolean(tail.get(run.id)?.length) ||
    Boolean(asked?.approval || asked?.question);

  return divided ? undefined : last;
}

/**
 * The conversation as rows to draw, in order: each line or joined answer with the work around
 * it, then what was sent and has not come back, then the turns at work. Never reads the text a
 * turn is writing, so a text update builds nothing.
 */
export function buildRows(input: RowsInput): Row[] {
  const { messages, tools, asks, run, keys, seen } = input;
  const isRunning = running(run);
  const steers = steersOf(messages);
  const placed = placeTurns(input, steers);
  const crew = placeCrew(input.subagents, messages.filter(answers));
  const call = pendingCall(messages);
  const facts = survey(messages);
  // The turns still at work: their last stretch of tools is drawn at the end, not in place.
  const under = new Set([
    ...(run && isRunning ? [run.id] : []),
    ...(call && input.callRun && running(input.callRun) ? [input.callRun.id] : []),
  ]);
  const rows: Row[] = [];

  const groups = groupMessages(messages, placed, crew.before, asks);
  const host = hostOf(input, groups.at(-1)?.lastMessage, placed, crew.tail);

  for (const group of groups) {
    const { lastMessage, index, lastIndex } = group;
    const message = steady(group, messages);
    const steered = steers.has(message.id);
    const answering = turnOf(message);
    const place = answering && (answers(message) || steered) ? placed.get(answering) : undefined;
    // The tools a turn used before its first line go above it: the first thing it said, or a
    // line the owner sent before it said anything.
    const head =
      answering && place?.first?.id === message.id && place.head.length ? place.head : undefined;
    const span = answering ? facts.spans.get(answering) : undefined;
    const headSpan = head && {
      startedAt: head[0]?.startedAt ?? span?.startedAt,
      finishedAt: head.at(-1)?.finishedAt ?? span?.finishedAt,
    };
    const crewBefore = crew.before.get(message.id) ?? [];
    const asked = message.runId ? asks.get(message.runId) : undefined;
    // A run that stops to ask ends on the line it asked with: its last word is the card,
    // whatever the gateway wrote in it.
    const asking =
      message.role === 'assistant' &&
      (facts.lastAssistant.get(message.runId ?? '') ?? -1) <= lastIndex;
    // What the gateway wrote around a pause stays out: the note that tells the agent to carry
    // on, Compact now, and the reply that answered or decided, which its card already shows.
    const pause =
      message.purpose === 'resume' ||
      message.purpose === 'compact' ||
      (message.purpose === 'answer' && Boolean(asked?.question || asked?.approval));
    // A finished agent's report is the agent's mail; its card already says it ended.
    const hidden = pause || Boolean(reportOf(message, input.subagents));

    if (hidden) {
      if (steered && head)
        rows.push({ kind: 'work', key: `head:${message.id}`, steps: head, ...headSpan });
    } else if (asking && asked?.approval && message.runId) {
      const key = `approval:${message.id}`;
      rows.push({
        kind: 'approval',
        key,
        runId: message.runId,
        approval: asked.approval,
        head,
        headSpan,
        crewBefore,
        fresh: !seen.has(key),
      });
    } else if (asking && asked?.question && message.runId) {
      const key = `question:${message.id}`;
      rows.push({
        kind: 'question',
        key,
        runId: message.runId,
        question: asked.question,
        head,
        headSpan,
        crewBefore,
        fresh: !seen.has(key),
      });
    } else {
      const key = keys.get(message.id) ?? message.id;
      rows.push({
        kind: 'message',
        key,
        message,
        lastMessage,
        previous: messages[index - 1],
        head,
        headSpan,
        steered,
        crewBefore,
        liveTail: lastMessage === host,
        fresh: !seen.has(key),
        drawn: (message.runId ? tools.get(message.runId) : undefined)?.find(
          (step) => step.toolName === 'generate_image' && step.aspectRatio,
        )?.aspectRatio,
      });
    }

    // The tools after this line, until the next: under it, where they happened. The last
    // stretch of a turn still at work belongs to its live row at the end.
    const later =
      place && !(answering && under.has(answering) && place.last?.id === lastMessage.id)
        ? place.after.get(lastMessage.id)
        : undefined;
    if (later?.length) {
      rows.push({
        kind: 'work',
        key: `after:${lastMessage.id}`,
        steps: later,
        startedAt: lastMessage.createdAt,
      });
    }

    // A turn that never answered keeps what it did under the line that asked for it.
    const runId = message.runId;
    const unanswered =
      runId &&
      message.role === 'user' &&
      !message.call &&
      !placed.has(runId) &&
      !(run?.id === runId && isRunning) &&
      !facts.lastAssistant.has(runId) &&
      (facts.lastUser.get(runId) ?? -1) <= lastIndex
        ? tools.get(runId)
        : undefined;
    if (runId && unanswered) {
      rows.push({
        kind: 'work',
        key: `unanswered:${runId}`,
        steps: unanswered,
        ...facts.spans.get(runId),
      });
    }

    const live = isRunning && run?.id === runId;
    const tail =
      runId && !live && messages[lastIndex + 1]?.runId !== runId ? crew.tail.get(runId) : undefined;
    if (runId && tail?.length) rows.push({ kind: 'crew', key: `crew:${runId}`, agents: tail });

    // Every settled turn keeps its files under its last line, not only the latest, which the
    // next message replaces as the conversation's run.
    const settled =
      answering &&
      answers(message) &&
      (answering !== run?.id || (!isRunning && run.status !== 'waiting')) &&
      (facts.lastAnswer.get(answering) ?? -1) <= lastIndex;
    const files = settled ? tools.get(answering) : undefined;
    if (answering && files && changed(files)) {
      rows.push({ kind: 'changes', key: `changes:${answering}`, runId: answering, steps: files });
    }
  }

  return [...rows, ...liveRows(input, { placed, crew, call, hosted: Boolean(host) })];
}
