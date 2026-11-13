import { describe, expect, it } from 'vitest';
import { findMatches, hitsByLine, markLine, matchLabel, stepMatch } from './find';

describe('finding words in a file', () => {
  const lines = ['const Price = price * 2;', '', 'return PRICE;'];

  it('finds every place, whatever its case, in reading order', () => {
    expect(findMatches(lines, 'price')).toEqual({
      matches: [
        { line: 0, start: 6, end: 11 },
        { line: 0, start: 14, end: 19 },
        { line: 2, start: 7, end: 12 },
      ],
      capped: false,
    });
  });

  it('looks for nothing when nothing is typed', () => {
    expect(findMatches(lines, '').matches).toEqual([]);
  });

  it('reads what is typed as words, not as a pattern', () => {
    expect(findMatches(['a.b', 'axb', 'f(x) [y] $1 \\d'], 'a.b').matches).toEqual([
      { line: 0, start: 0, end: 3 },
    ]);
    expect(findMatches(['f(x) [y] $1 \\d'], '(x) [y] $1 \\d').matches).toHaveLength(1);
    expect(findMatches(['anything'], '.*').matches).toEqual([]);
  });

  it('never counts overlapping places twice', () => {
    expect(findMatches(['aaaa'], 'aa').matches).toEqual([
      { line: 0, start: 0, end: 2 },
      { line: 0, start: 2, end: 4 },
    ]);
  });

  it('places a match in the line as written when a letter changes length in lower case', () => {
    // 'İ' is one unit and lowers to two: a search over a lowered copy would be one off after it.
    const [match] = findMatches(['İİ price'], 'price').matches;
    expect('İİ price'.slice(match?.start, match?.end)).toBe('price');
  });

  it('stops at the cap and says there are more', () => {
    const found = findMatches(['aaaaa', 'aaaaa'], 'a', 7);
    expect(found.matches).toHaveLength(7);
    expect(found.capped).toBe(true);
    expect(findMatches(['aaaaa'], 'a', 7).capped).toBe(false);
  });
});

describe('moving among matches', () => {
  it('goes on and back, round to the other end', () => {
    expect(stepMatch(0, 3, 1)).toBe(1);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(0);
  });

  it('says where the bar is among them', () => {
    expect(matchLabel(2, 12, false)).toBe('3 of 12');
    expect(matchLabel(0, 0, false)).toBe('No results');
    expect(matchLabel(0, 5000, true)).toBe('1 of 5,000+');
  });
});

describe('marking a highlighted line', () => {
  const marked = (segments: { text: string; className?: string }[], query: string) => {
    const line = segments.map((segment) => segment.text).join('');
    const hits = hitsByLine(findMatches([line], query).matches).get(0) ?? [];
    return markLine(segments, hits);
  };

  it('keeps the text whole and marks only what was found', () => {
    const pieces = marked([{ text: 'const price = 1;' }], 'price');

    expect(pieces.map((piece) => piece.text).join('')).toBe('const price = 1;');
    expect(pieces.filter((piece) => piece.hit !== undefined).map((piece) => piece.text)).toEqual([
      'price',
    ]);
  });

  it('marks a match across two colours and keeps each', () => {
    const pieces = marked(
      [
        { text: 'const ', className: 'hljs-keyword' },
        { text: 'pri', className: 'hljs-title' },
        { text: 'ce = 1;' },
      ],
      'price',
    );

    expect(pieces.filter((piece) => piece.hit !== undefined)).toEqual([
      { text: 'pri', className: 'hljs-title', hit: 0 },
      { text: 'ce', hit: 0 },
    ]);
    expect(pieces.map((piece) => piece.text).join('')).toBe('const price = 1;');
  });

  it('numbers the matches of a later line by their place among all of them', () => {
    const hits = hitsByLine(findMatches(['a a', 'b', 'a'], 'a').matches);

    expect(hits.get(1)).toBeUndefined();
    expect(markLine([{ text: 'a' }], hits.get(2) ?? [])).toEqual([{ text: 'a', hit: 2 }]);
  });

  it('tells two matches that touch apart', () => {
    const pieces = marked([{ text: 'abab' }], 'ab');
    expect(pieces).toEqual([
      { text: 'ab', hit: 0 },
      { text: 'ab', hit: 1 },
    ]);
  });
});
