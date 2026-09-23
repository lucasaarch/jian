import { describe, expect, it } from 'vitest';
import { plainText } from '../src/channels/plain.js';

describe('what a bubble that does not render markdown receives', () => {
  it('turns a table into rows a phone can read', () => {
    const answer = [
      'Os dois planos:',
      '',
      '| Plano | Preço | Prazo |',
      '| --- | ---: | --- |',
      '| Básico | R$ 30 | 12 meses |',
      '| Pro | R$ 90 | 24 meses |',
    ].join('\n');

    // One message, not one per row: a blank line between rows is a message boundary, and a
    // table of twelve rows became twelve notifications.
    expect(plainText(answer)).toBe(
      [
        'Os dois planos:',
        '',
        'Básico',
        'Preço: R$ 30',
        'Prazo: 12 meses',
        '—',
        'Pro',
        'Preço: R$ 90',
        'Prazo: 24 meses',
      ].join('\n'),
    );
  });

  it('drops the marks that would arrive as punctuation', () => {
    expect(plainText('# Título\n\n**Isso** é _importante_ e `exato`.')).toBe(
      'Título\n\nIsso é importante e exato.',
    );
  });

  it('keeps the code inside a fence and loses only the fence', () => {
    expect(plainText('Rode isto:\n\n```bash\nmake up\n```')).toBe('Rode isto:\n\nmake up');
  });

  it('keeps a list readable and names a link instead of hiding it', () => {
    expect(plainText('- Um\n- [Docs](https://exemplo.com)')).toBe(
      '• Um\n• Docs: https://exemplo.com',
    );
  });

  it('leaves ordinary text alone, asterisks and underscores included', () => {
    const answer = 'O arquivo é run_agent.py e o preço subiu 3 * 2 vezes.';

    expect(plainText(answer)).toBe(answer);
  });
});
