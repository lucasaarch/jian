/**
 * A spreadsheet's CSV as far as the agent has written it, read as the sheet reads a whole one
 * (the gateway's sheet-model.ts): a quote opens a cell only at its start, `""` inside one is a
 * quote, and a line break outside quotes ends a row (`\n`, `\r\n` or `\r`).
 *
 * It is read again every time more arrives, so it carries on from where the last read stopped:
 * the rows already ended are kept, the very same arrays, and only the row still being written and
 * what came after it are read. A text that is not the last one with more after it is read whole.
 */
export type SheetRead = {
  /** The text read. */
  text: string;
  /** The rows ended by a line break, each the same array from one read to the next. */
  rows: string[][];
  /** Where the row after the last ended one starts in `text`. */
  end: number;
  /** The row still being written, its last cell the one being written; none at a row's start. */
  open: string[] | undefined;
};

export function readSheet(text: string, before?: SheetRead): SheetRead {
  const going =
    before !== undefined &&
    text.length >= before.end &&
    text.startsWith(before.text.slice(0, before.end));
  const rows = going ? before.rows.slice() : [];
  let end = going ? before.end : 0;
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false;

  for (let i = end; i < text.length; i++) {
    const c = text[i];
    started = true;
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      }
      // A quote last of all may be the first of `""`: the cell stays open until more comes.
      else if (i + 1 < text.length) quoted = false;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      // A `\r` last of all may be the first half of `\r\n`: what follows decides.
      if (c === '\r' && i + 1 === text.length) break;
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      started = false;
      end = i + 1;
    } else cell += c;
  }

  return { text, rows, end, open: started ? [...row, cell] : undefined };
}

/** The name of a column as a sheet gives it, from 0: A, B, … Z, AA. */
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}
