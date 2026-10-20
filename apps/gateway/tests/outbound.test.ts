import { describe, expect, it } from 'vitest';
import { remainingOutbound } from '../src/channels/outbound.js';

describe('what is left to send after commentary', () => {
  it('sends the whole answer when nothing was flushed early', () => {
    expect(remainingOutbound('Twelve open.', [])).toBe('Twelve open.');
  });

  it('skips a final that is only the last commentary paragraph', () => {
    expect(remainingOutbound('Done on the remote.', ['Checking.', 'Done on the remote.'])).toBe(
      undefined,
    );
  });

  it('drops leading commentary that saySoFar already put on the phone', () => {
    expect(
      remainingOutbound('Opening the board now.\n\nTwelve open.', ['Opening the board now.']),
    ).toBe('Twelve open.');
  });

  it('drops every flushed paragraph from a restated final', () => {
    expect(remainingOutbound('A.\n\nB.\n\nC.', ['A.', 'B.'])).toBe('C.');
  });

  it('leaves an unrelated final alone so new words still go out', () => {
    expect(remainingOutbound('Something else.', ['Opening the board now.'])).toBe(
      'Something else.',
    );
  });

  it('returns nothing when the final only repeats flushed paragraphs', () => {
    expect(remainingOutbound('A.\n\nB.', ['A.', 'B.'])).toBe(undefined);
  });
});
