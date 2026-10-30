import { describe, expect, it } from 'vitest';
import { conversational } from '../src/channels/conversation.js';

describe('an answer as a person would send it', () => {
  it('leaves a short reply as one message', () => {
    expect(conversational('Sure, go ahead.', 4000)).toEqual(['Sure, go ahead.']);
  });

  it('sends one message per paragraph the agent wrote', () => {
    const answer = 'I took a look.\n\nThe deploy is cleared.\n\nShould I let the team know?';

    expect(conversational(answer, 4000)).toEqual([
      'I took a look.',
      'The deploy is cleared.',
      'Should I let the team know?',
    ]);
  });

  it('keeps a list with nothing but the list, and its intro before it', () => {
    expect(conversational('The plans:\n\n• Basic\n• Pro', 4000)).toEqual([
      'The plans:',
      '• Basic\n• Pro',
    ]);
  });

  it('divides a paragraph that does not fit at a sentence end', () => {
    const long = `${'a'.repeat(30)}. ${'B'.repeat(30)}. ${'C'.repeat(30)}.`;
    const parts = conversational(long, 40);

    expect(parts.every((part) => part.length <= 40)).toBe(true);
    expect(parts.join(' ')).toBe(long);
  });

  it('cuts by length only when one sentence is longer than a whole message', () => {
    const parts = conversational('x'.repeat(90), 40);

    expect(parts).toEqual(['x'.repeat(40), 'x'.repeat(40), 'x'.repeat(10)]);
  });

  it('never turns an answer into a notification storm', () => {
    const parts = conversational(
      Array.from({ length: 30 }, (_, index) => `Paragraph ${index}.`).join('\n\n'),
      4000,
    );

    expect(parts).toHaveLength(8);
    expect(parts.at(-1)).toContain('Paragraph 29.');
  });
});
