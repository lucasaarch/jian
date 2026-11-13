'use client';

import { type CSSProperties, memo, useEffect, useRef } from 'react';
import type { Segment } from '../../ui/highlight';
import { type LineHits, markLine, type Piece } from './find';

const NO_HITS: LineHits = [];

/**
 * One line. Memoised on what it draws, so typing in the find bar redraws the lines that gain or
 * lose a mark and leaves the other thousands alone.
 */
const Line = memo(function Line({
  number,
  segments,
  hits,
  current,
}: {
  number: number;
  segments: Segment[];
  hits: LineHits;
  /** The current match, by its place among all of them, when it is on this line. */
  current?: number;
}) {
  const pieces: Piece[] = hits.length ? markLine(segments, hits) : segments;

  return (
    <span className="file-code-line" data-line={number}>
      {pieces.map((piece, index) => {
        const text = piece.className ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: pieces are positions, never reordered.
          <span key={index} className={piece.className}>
            {piece.text}
          </span>
        ) : (
          piece.text
        );
        return piece.hit === undefined ? (
          text
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: pieces are positions, never reordered.
          <mark key={index} data-current={piece.hit === current || undefined}>
            {text}
          </mark>
        );
      })}
      {'\n'}
    </span>
  );
});

/**
 * A file's text as an editor shows it: numbered lines, coloured where the highlighter knew the
 * language, and the find bar's matches marked. The numbers are drawn, not text, so copying by
 * hand takes only the code. Read only: nothing here can be typed into.
 */
export const CodeView = memo(function CodeView({
  lines,
  wrap,
  hits,
  current,
}: {
  lines: Segment[][];
  wrap: boolean;
  /** The find bar's matches by line, from 0. */
  hits: Map<number, LineHits>;
  /** The match the find bar is on: its line, and its place among all of them. */
  current?: { line: number; index: number };
}) {
  const scroller = useRef<HTMLDivElement>(null);

  // The match the bar moved to comes into view, in the middle so its lines around it show.
  // biome-ignore lint/correctness/useExhaustiveDependencies: every move of the bar, and every new set of matches.
  useEffect(() => {
    scroller.current
      ?.querySelector('mark[data-current]')
      ?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  }, [current?.index, hits]);

  return (
    <div
      ref={scroller}
      className="file-code"
      data-wrap={wrap || undefined}
      // As wide as the last line's number, so the code starts at the same place on every line.
      style={{ '--file-gutter': `${String(lines.length).length}ch` } as CSSProperties}
    >
      <pre className="code-block-lines file-code-lines">
        <code>
          {lines.map((segments, row) => (
            <Line
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positions, never reordered.
              key={row}
              number={row + 1}
              segments={segments}
              hits={hits.get(row) ?? NO_HITS}
              {...(current?.line === row ? { current: current.index } : {})}
            />
          ))}
        </code>
      </pre>
    </div>
  );
});
