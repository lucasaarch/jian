import type { Message, Run, Subagent, ToolStep } from '../../../lib/api';
import { landed, type Outgoing } from '../../../lib/stores/outbox';
import { running } from '../status';
import type { Placed, Row, RowsInput } from './rows';

type Turns = {
  placed: Map<string, Placed>;
  crew: { tail: Map<string, Subagent[]> };
  /** The question carried to another agent whose answer has not come back. */
  call: Message['call'];
  /** The writing under way is drawn by the answer it will join: no live row of its own. */
  hosted: boolean;
};

/** A turn under way keeps the tools since its last line for its live row at the end. */
function trailing(turn: Run, known: Map<string, ToolStep[]>, placed: Map<string, Placed>) {
  const place = placed.get(turn.id);

  return place?.last
    ? { steps: place.after.get(place.last.id) ?? [], startedAt: place.last.createdAt }
    : { steps: known.get(turn.id) ?? [], startedAt: turn.createdAt };
}

/**
 * What the owner sent into a turn already at work. The gateway files it among that turn's tools
 * by its own clock, so the tools that began before it stay above it; the pending bubble is drawn
 * the same way, or it would sit above work that is about to climb over it once it is stored.
 */
function steeredInto(run: Run | undefined, pending: Outgoing[]) {
  if (!run || !running(run)) return [];
  const since = Date.parse(run.createdAt);

  // One sent before the turn existed is the message that opened it.
  return pending.filter((item) => Date.parse(item.at) > since);
}

/**
 * The end of the conversation: what the owner sent that has not come back, where the stored
 * message will stand, then the turns at work. Sent and not yet seen at work, the agent is drawn
 * starting under the same key it keeps once at work, so the row only changes its label.
 */
export function liveRows(input: RowsInput, { placed, crew, call, hosted }: Turns): Row[] {
  const { messages, run, callRun, sessionId } = input;
  const isRunning = running(run);
  const pending = input.outgoing.filter(
    (item) => item.sessionId === sessionId && !landed(item, messages),
  );
  // A command is not something said: it is drawn only when it failed, to be sent again.
  const said = pending.filter((item) => !item.quiet || item.state === 'failed');
  const steered = hosted ? [] : steeredInto(run, said);
  const rows: Row[] = said
    .filter((item) => !steered.includes(item))
    .map((item) => ({ kind: 'outgoing', key: item.key, item }));
  const key = `live:${input.liveSerial}`;

  // Timed from when the gateway was seen to take each turn, not from the click: a read that
  // began in between may not hold the turn yet, and must not be taken for one that does.
  const sending = pending.filter((item) => item.state === 'sending').map((item) => item.at);
  const startingAt =
    !isRunning && (sending.length || input.awaited.size)
      ? [...sending, ...input.awaited.values()].sort().at(-1)
      : undefined;
  if (startingAt) {
    rows.push({
      kind: 'live',
      key,
      side: 'self',
      status: 'queued',
      createdAt: startingAt,
      steps: [],
      startedAt: startingAt,
      crew: [],
    });
  }

  if (call && callRun && running(callRun)) {
    rows.push({
      kind: 'live',
      key: `call-live:${callRun.id}`,
      runId: callRun.id,
      side: 'call',
      status: callRun.status,
      createdAt: callRun.createdAt,
      ...trailing(callRun, input.callTools, placed),
      crew: [],
    });
  }

  if (run && isRunning && !hosted) {
    let { steps, startedAt } = trailing(run, input.tools, placed);

    for (const item of steered) {
      const before = steps.filter((step) => Date.parse(step.startedAt) < Date.parse(item.at));
      steps = steps.slice(before.length);
      if (before.length) {
        // Keyed as the stored message's own row will be (see `buildRows`), so landing is no jump.
        rows.push({
          kind: 'work',
          key: `head:${item.key}`,
          runId: run.id,
          steps: before,
          startedAt: before[0]?.startedAt ?? startedAt,
          finishedAt: before.at(-1)?.finishedAt,
        });
      }
      rows.push({ kind: 'outgoing', key: item.key, item });
      startedAt = item.at;
    }

    rows.push({
      kind: 'live',
      key,
      runId: run.id,
      side: 'self',
      status: run.status,
      createdAt: run.createdAt,
      steps,
      startedAt,
      crew: crew.tail.get(run.id) ?? [],
    });
  }

  return rows;
}
