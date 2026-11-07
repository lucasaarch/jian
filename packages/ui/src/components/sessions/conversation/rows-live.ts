import type { Message, Run, Subagent, ToolStep } from '../../../lib/api';
import { landed } from '../../../lib/stores/outbox';
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
  const rows: Row[] = pending
    // A command is not something said: it is drawn only when it failed, to be sent again.
    .filter((item) => !item.quiet || item.state === 'failed')
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
    rows.push({
      kind: 'live',
      key,
      runId: run.id,
      side: 'self',
      status: run.status,
      createdAt: run.createdAt,
      ...trailing(run, input.tools, placed),
      crew: crew.tail.get(run.id) ?? [],
    });
  }

  return rows;
}
