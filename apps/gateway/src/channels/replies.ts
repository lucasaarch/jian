import type { ChannelMessages, RunApproval, RunQuestion } from '@jian/contracts';
import type { Judge } from '../decisions/service.js';

/** A chat reply is waiting on this answer; past it the gateway reads the words itself. */
const TIMEOUT_MS = 1500;
/** Jev's reading must reach this probability, or the reply is taken for what it literally says. */
const THRESHOLD = 0.6;
const REPLY_CHARS = 2000;

/** Case, accents and the punctuation people end a word with are not what decides a reply. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[.!?,;:]+$/u, '')
    .trim();
}

/** Puts the values in a channel's wording, and drops the gaps a value left empty. */
export function fill(template: string, values: Record<string, string>): string {
  return template
    .replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** What an approval says in a chat, and the two replies a keyboard offers for it. */
export function approvalMessage(wording: ChannelMessages, approval: RunApproval) {
  const yes = wording.approveWords[0] ?? 'yes';
  const no = wording.rejectWords[0] ?? 'no';

  return {
    text: fill(wording.approval, {
      title: approval.title,
      detail: approval.detail,
      confirm: approval.confirmLabel,
      yes,
      no,
    }),
    // A button says what it does; its text is what comes back, and is read as a yes.
    options: [approval.confirmLabel, no],
  };
}

export function questionMessage(wording: ChannelMessages, question: RunQuestion): string {
  const options = (question.choices ?? []).map((choice, index) => `${index + 1}. ${choice}`);

  return fill(wording.question, { prompt: question.prompt, options: options.join('\n') });
}

/**
 * The decision a reply states in so many words: one of the channel's yes or no words, or the
 * approve button's own label. Anything longer is not read here.
 */
export function statedDecision(
  wording: ChannelMessages,
  approval: Pick<RunApproval, 'confirmLabel'>,
  reply: string,
): 'approve' | 'reject' | undefined {
  const said = fold(reply);

  if ([...wording.approveWords, approval.confirmLabel].some((word) => fold(word) === said)) {
    return 'approve';
  }
  if (wording.rejectWords.some((word) => fold(word) === said)) return 'reject';

  return undefined;
}

/**
 * What a reply to a pending approval decides. The words the owner configured first; then Jev,
 * which reads a "go ahead, send it" as the yes it is; and without a confident reading, a no
 * that keeps what was said. An unclear reply never approves: the cost of asking again is a
 * message, the cost of a wrong yes is the action itself.
 */
export async function readApprovalReply(
  judge: Judge | undefined,
  wording: ChannelMessages,
  approval: RunApproval,
  reply: string,
): Promise<{ decision: 'approve' | 'reject'; note?: string }> {
  const stated = statedDecision(wording, approval, reply);
  if (stated) return { decision: stated };

  const answers = await judge?.(
    {
      action: { title: approval.title, detail: approval.detail },
      reply: reply.slice(0, REPLY_CHARS),
    },
    {
      decision: {
        type: 'choice',
        instructions:
          'An assistant asked a person to approve `action` and they wrote `reply`. What does the reply decide?',
        criteria: {
          approve: 'It clearly allows the action to go ahead as described.',
          reject: 'It refuses the action or asks for it not to happen.',
          other: 'It does neither: a question, a change to the action, or something else.',
        },
      },
    },
    { use: 'replies', timeoutMs: TIMEOUT_MS },
  );
  const read = answers?.decision;

  if (
    read?.type === 'choice' &&
    (read.choice === 'approve' || read.choice === 'reject') &&
    (read.probabilities[read.choice] ?? 0) >= THRESHOLD
  ) {
    return read.choice === 'approve'
      ? { decision: 'approve' }
      : { decision: 'reject', note: reply };
  }

  return { decision: 'reject', note: reply };
}

/**
 * The choice a reply to a question names: its number, or in other words through Jev. A reply
 * that names none is the answer as written.
 */
export async function readQuestionReply(
  judge: Judge | undefined,
  question: RunQuestion,
  reply: string,
): Promise<string> {
  const choices = question.choices ?? [];
  if (!choices.length) return reply;

  const number = /^\s*(\d{1,2})\s*[.)]?\s*$/.exec(reply);
  const picked = number ? choices[Number(number[1]) - 1] : undefined;
  if (picked) return picked;

  const exact = choices.find((choice) => fold(choice) === fold(reply));
  if (exact) return exact;

  const answers = await judge?.(
    { question: question.prompt, reply: reply.slice(0, REPLY_CHARS) },
    {
      choice: {
        type: 'choice',
        instructions:
          'A person was asked `question` and wrote `reply`. Which option did they pick?',
        criteria: {
          ...Object.fromEntries(choices.map((choice, index) => [`c${index}`, choice])),
          other: 'None of the options: they wrote something else.',
        },
      },
    },
    { use: 'replies', timeoutMs: TIMEOUT_MS },
  );
  const read = answers?.choice;

  if (
    read?.type === 'choice' &&
    read.choice.startsWith('c') &&
    (read.probabilities[read.choice] ?? 0) >= THRESHOLD
  ) {
    return choices[Number(read.choice.slice(1))] ?? reply;
  }

  return reply;
}
