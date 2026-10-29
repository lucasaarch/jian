import { randomUUID } from 'node:crypto';
import type { RunQuestion } from '@jian/contracts';

/** Thrown from `ask_user` so the runtime can park the run instead of failing the tool. */
export class AskUserPause extends Error {
  readonly question: Pick<RunQuestion, 'prompt' | 'choices' | 'recommended'>;

  constructor(question: { prompt: string; choices?: string[]; recommended?: string }) {
    super('Waiting for the owner’s answer');
    this.name = 'AskUserPause';
    this.question = question;
  }
}

/** The choices as a numbered list, the recommended one saying so. */
export function numberedChoices(question: Pick<RunQuestion, 'choices' | 'recommended'>): string[] {
  return (question.choices ?? []).map(
    (choice, index) =>
      `${index + 1}. ${choice}${choice === question.recommended ? ' (recommended)' : ''}`,
  );
}

export function formatQuestionText(
  question: Pick<RunQuestion, 'prompt' | 'choices' | 'recommended'>,
): string {
  if (!question.choices?.length) return question.prompt;

  return `${question.prompt}\n\n${numberedChoices(question).join('\n')}`;
}

export function buildRunQuestion(
  input: { prompt: string; choices?: string[]; recommended?: string },
  askedAt: string,
): RunQuestion {
  const choices = input.choices?.length ? input.choices : undefined;
  // Only a choice on offer can be the recommended one; anything else is dropped, not shown.
  const recommended = choices?.find((choice) => choice === input.recommended?.trim());

  return {
    id: randomUUID(),
    prompt: input.prompt,
    askedAt,
    ...(choices ? { choices } : {}),
    ...(recommended ? { recommended } : {}),
  };
}

export function resumePrompt(question: RunQuestion, answer: string): string {
  return [
    'The owner answered the mid-run question. Continue the work with this answer — do not ask them to continue.',
    '',
    `Question: ${question.prompt}`,
    ...(question.choices?.length ? [`Choices were: ${question.choices.join(' | ')}`] : []),
    `Answer: ${answer}`,
  ].join('\n');
}
