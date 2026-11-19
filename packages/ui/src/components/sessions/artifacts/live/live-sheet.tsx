'use client';

import { memo, useEffect, useMemo, useRef } from 'react';
import { InspectorBody } from '../../inspector';
import { columnName, readSheet, type SheetRead } from './sheet-read';

/** A number as a sheet would set it: to the right. */
const NUMBER = /^[-+]?[\d.,]+%?$/;

/**
 * One cell as written: its text, never markup. A formula is not worked out here; its text stands
 * quiet with a light passing over it until the sheet itself draws it, worked out.
 */
function Cell({ text, writing }: { text: string; writing: boolean }) {
  const formula = text.startsWith('=');
  return (
    <td
      data-writing={writing || undefined}
      className={`live-sheet-cell ${formula ? 'live-sheet-formula font-mono text-xs text-muted italic' : NUMBER.test(text) ? 'text-right tabular-nums' : ''}`}
    >
      <span className="block max-w-64 truncate">
        {text}
        {writing && <span aria-hidden="true" className="live-sheet-caret" />}
      </span>
    </td>
  );
}

/**
 * One row. A row the agent has finished is the same array from one read to the next, so it is
 * drawn once: only the row being written is drawn again as it grows.
 */
const Row = memo(function Row({
  index,
  cells,
  columns,
  writing,
}: {
  index: number;
  cells: string[];
  columns: number;
  /** The cell being written in this row, or -1. */
  writing: number;
}) {
  return (
    <tr className="live-sheet-row">
      <th scope="row" className="live-sheet-number">
        {index + 1}
      </th>
      {Array.from({ length: columns }, (_, column) => (
        <Cell
          // A column's place is what it is.
          // biome-ignore lint/suspicious/noArrayIndexKey: cells are named by where they stand.
          key={column}
          text={cells[column] ?? ''}
          writing={column === writing}
        />
      ))}
    </tr>
  );
});

/**
 * A spreadsheet as the agent writes it, drawn as a sheet rather than its CSV: rows and columns
 * appear as they arrive, with the cell being written gently marked, and the view follows it.
 * Read again on every chunk from where the last read stopped (sheet-read.ts). What is drawn is
 * the cells' text and nothing else: nothing written by the agent is ever read as markup here.
 */
export function LiveSheet({ content, done = false }: { content: string; done?: boolean }) {
  const last = useRef<SheetRead>(undefined);
  const read = useMemo(() => {
    const next = readSheet(content, last.current);
    last.current = next;
    return next;
  }, [content]);
  const rows = read.open ? [...read.rows, read.open] : read.rows;
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const at = read.open && !done ? { row: rows.length - 1, column: read.open.length - 1 } : null;
  const body = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: what is written moves the cell in view.
  useEffect(() => {
    body.current
      ?.querySelector('[data-writing]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [content]);

  return (
    <InspectorBody className="px-(--inspector-inset)">
      <div ref={body} className="live-sheet pt-2">
        <table aria-label="Spreadsheet being written" aria-busy={!done}>
          <thead>
            <tr>
              <td className="live-sheet-corner" />
              {Array.from({ length: columns }, (_, column) => (
                <th
                  // biome-ignore lint/suspicious/noArrayIndexKey: a column is named by its place.
                  key={column}
                  scope="col"
                  className="live-sheet-column"
                >
                  {columnName(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((cells, index) => (
              <Row
                // biome-ignore lint/suspicious/noArrayIndexKey: a row is named by its place.
                key={index}
                index={index}
                cells={cells}
                columns={columns}
                writing={at?.row === index ? at.column : -1}
              />
            ))}
          </tbody>
        </table>
      </div>
    </InspectorBody>
  );
}
