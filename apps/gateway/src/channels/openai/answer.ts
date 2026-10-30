import type { Run, RunApproval } from '@jian/contracts';
import { formatQuestionText } from '../../agent/ask-user.js';
import type { RunReader } from '../../runs/port.js';
import type { Store } from '../../storage/database.js';

/**
 * How long a request waits for the agent's answer, in milliseconds. Giving up stops only the
 * wait: the run carries on, and the same request sent again waits for that same run.
 */
export const ANSWER_WAIT_MS = 10 * 60_000;

/** The longest between two looks at a run when no commit wakes the wait sooner, in ms. */
const POLL_MS = 1000;

/** A run that will not change until someone acts, or that has ended. */
const SETTLED = new Set<Run['status']>([
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'waiting',
]);

export type AnswerDeps = {
  runs: RunReader;
  store: Pick<Store, 'waitForEvent'>;
};

/**
 * The run once it settles, or undefined when the wait ran out or the client left first.
 * `working` sees the run each time it is read while still at work.
 */
export async function settle(
  deps: AnswerDeps,
  profileId: string,
  runId: string,
  signal: AbortSignal,
  working?: (run: Run) => void,
): Promise<Run | undefined> {
  const deadline = Date.now() + ANSWER_WAIT_MS;

  while (!signal.aborted) {
    const run = await deps.runs.run(profileId, runId);

    if (SETTLED.has(run.status)) return run;

    working?.(run);

    const remaining = deadline - Date.now();

    if (remaining <= 0) return undefined;

    const wake = new AbortController();
    const stop = () => wake.abort();
    const timer = setTimeout(stop, Math.min(POLL_MS, remaining));

    signal.addEventListener('abort', stop, { once: true });

    try {
      await deps.store.waitForEvent(profileId, wake.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      wake.abort();
    }
  }

  return undefined;
}

function approvalText(approval: RunApproval | undefined) {
  const action = approval ? `: ${approval.title}` : '';

  return `This request is waiting for approval in Jian${action}. The owner can approve or reject it there; send this same request again afterwards to read the answer.`;
}

/** What a settled run says to the client: its answer, or why it has none. */
export function answerOf(run: Run): { content: string } | { failure: string } {
  switch (run.status) {
    case 'completed':
      return { content: run.output ?? '' };
    case 'waiting':
      // The next message answers a question; only the owner, in Jian, decides an approval.
      return {
        content: run.question ? formatQuestionText(run.question) : approvalText(run.approval),
      };
    case 'cancelled':
      return { failure: 'The run was cancelled in Jian' };
    case 'interrupted':
      return { failure: `The run was interrupted${run.error ? `: ${run.error}` : ''}` };
    default:
      return { failure: run.error ?? 'The run failed' };
  }
}

/** Token counts as OpenAI reports them. An estimate may be fractional; these are integers. */
export function usageOf(run: Run) {
  const prompt = Math.round(run.usage?.inputTokens ?? 0);
  const completion = Math.round(run.usage?.outputTokens ?? 0);

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

/**
 * What a streamed answer has said, so each event carries only what is new. A run's progress is
 * the answer segment being written, and it starts over when a tool interrupts it: the new
 * segment then follows what was already sent after a blank line, because text a client has
 * received cannot be taken back.
 */
export class StreamedText {
  private segment = '';
  private said = '';

  next(text: string): string {
    if (this.segment && !text.startsWith(this.segment)) this.segment = '';

    let delta: string;

    if (this.segment) {
      delta = text.slice(this.segment.length);
    } else {
      if (!text) return '';
      delta = this.said ? `\n\n${text}` : text;
    }

    this.segment = text;
    this.said += delta;

    return delta;
  }

  /**
   * What is left of the final answer, of which the last segment was a draft. The draft may
   * carry whitespace the answer was trimmed of; that alone is not a new segment.
   */
  finish(answer: string): string {
    const draft = this.segment.trimEnd();

    if (!draft || answer.startsWith(this.segment)) return this.next(answer);
    if (draft.startsWith(answer.trimEnd())) return '';
    if (answer.startsWith(draft)) {
      const delta = answer.slice(draft.length);

      this.segment = answer;
      this.said += delta;

      return delta;
    }

    return this.next(answer);
  }
}
