import { describe, expect, it } from 'vitest';
import { plainText } from '../src/channels/plain.js';

describe('what a bubble that does not render markdown receives', () => {
  it('turns a table into rows a phone can read', () => {
    const answer = [
      'The two plans:',
      '',
      '| Plan | Price | Term |',
      '| --- | ---: | --- |',
      '| Basic | $30 | 12 months |',
      '| Pro | $90 | 24 months |',
    ].join('\n');

    // One message, not one per row: a blank line between rows is a message boundary, and a
    // table of twelve rows became twelve notifications.
    expect(plainText(answer)).toBe(
      [
        'The two plans:',
        '',
        'Basic',
        'Price: $30',
        'Term: 12 months',
        '—',
        'Pro',
        'Price: $90',
        'Term: 24 months',
      ].join('\n'),
    );
  });

  it('drops the marks that would arrive as punctuation', () => {
    expect(plainText('# Title\n\n**This** is _important_ and `exact`.')).toBe(
      'Title\n\nThis is important and exact.',
    );
  });

  it('keeps the code inside a fence and loses only the fence', () => {
    expect(plainText('Run this:\n\n```bash\nmake up\n```')).toBe('Run this:\n\nmake up');
  });

  it('keeps a list readable and names a link instead of hiding it', () => {
    expect(plainText('- One\n- [Docs](https://example.com)')).toBe(
      '• One\n• Docs: https://example.com',
    );
  });

  it('leaves ordinary text alone, asterisks and underscores included', () => {
    const answer = 'The file is run_agent.py and the price went up 3 * 2 times.';

    expect(plainText(answer)).toBe(answer);
  });
});
