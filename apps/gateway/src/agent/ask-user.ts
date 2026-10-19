import { randomUUID } from 'node:crypto';
import type { RunQuestion } from '@jian/contracts';

/** Thrown from `ask_user` so the runtime can park the run instead of failing the tool. */
export class AskUserPause extends Error {
  readonly question: Omit<RunQuestion, 'id' | 'askedAt'> & { choices?: string[] };

  constructor(question: { prompt: string; choices?: string[] }) {
    super('Waiting for the owner’s answer');
    this.name = 'AskUserPause';
    this.question = question;
  }
}

export function formatQuestionText(question: Pick<RunQuestion, 'prompt' | 'choices'>): string {
  if (!question.choices?.length) return question.prompt;

  const options = question.choices.map((choice, index) => `${index + 1}. ${choice}`).join('\n');
  return `${question.prompt}\n\n${options}`;
}

export function buildRunQuestion(
  input: { prompt: string; choices?: string[] },
  askedAt: string,
): RunQuestion {
  return {
    id: randomUUID(),
    prompt: input.prompt,
    askedAt,
    ...(input.choices?.length ? { choices: input.choices } : {}),
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
