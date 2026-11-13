import type { Segment } from '../../ui/highlight';

/** One place the words were found: a line from 0, and where in it, in UTF-16 units. */
export type Match = { line: number; start: number; end: number };

/**
 * The most matches kept. A single letter in a large file matches a hundred thousand times, and
 * each one is a mark to draw; past this the count says there are more.
 */
export const MAX_MATCHES = 5000;

/**
 * Every place `query` is in the lines, whatever its case, in reading order and never
 * overlapping. A regular expression finds them so a place is in the line as written: lowering a
 * line's case first can change its length, and every mark after it would be drawn off its word.
 */
export function findMatches(
  lines: readonly string[],
  query: string,
  cap = MAX_MATCHES,
): { matches: Match[]; capped: boolean } {
  const matches: Match[] = [];
  if (!query) return { matches, capped: false };
  const words = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

  for (const [line, text] of lines.entries()) {
    for (const found of text.matchAll(words)) {
      if (matches.length >= cap) return { matches, capped: true };
      matches.push({ line, start: found.index, end: found.index + found[0].length });
    }
  }
  return { matches, capped: false };
}

/** The match after or before the current one, round to the other end past the last. */
export const stepMatch = (current: number, count: number, by: 1 | -1) =>
  count ? (current + by + count) % count : 0;

/** "3 of 12", as the find bar says where it is. */
export function matchLabel(current: number, count: number, capped: boolean) {
  if (!count) return 'No results';
  return `${current + 1} of ${count.toLocaleString('en-US')}${capped ? '+' : ''}`;
}

/** The matches of each line, each with its place among all of them. */
export type LineHits = { start: number; end: number; index: number }[];

export function hitsByLine(matches: readonly Match[]): Map<number, LineHits> {
  const lines = new Map<number, LineHits>();
  for (const [index, { line, start, end }] of matches.entries()) {
    const hits = lines.get(line) ?? [];
    hits.push({ start, end, index });
    lines.set(line, hits);
  }
  return lines;
}

/** A piece of a line as drawn: coloured by the highlighter, and marked where the words are. */
export type Piece = Segment & { hit?: number };

/**
 * A highlighted line cut where its matches begin and end, so a match that spans two colours is
 * marked across both and keeps each. `hit` is the match's place among all of them.
 */
export function markLine(segments: readonly Segment[], hits: LineHits): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  let next = 0;

  for (const segment of segments) {
    let from = 0;
    while (from < segment.text.length) {
      // Matches wholly before this point are done with.
      while (hits[next] && (hits[next]?.end ?? 0) <= at + from) next += 1;
      const hit = hits[next];
      const inside = hit && hit.start <= at + from;
      const until = Math.min(
        segment.text.length,
        (inside ? hit.end : (hit?.start ?? Number.POSITIVE_INFINITY)) - at,
      );
      pieces.push({
        text: segment.text.slice(from, until),
        ...(segment.className ? { className: segment.className } : {}),
        ...(inside ? { hit: hit.index } : {}),
      });
      from = until;
    }
    at += segment.text.length;
  }
  return pieces;
}
