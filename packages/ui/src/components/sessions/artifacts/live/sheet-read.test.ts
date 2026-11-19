import { describe, expect, it } from 'vitest';
import { columnName, readSheet, type SheetRead } from './sheet-read';

const CSV = 'Item,Note,Cost\r\n"Desk, oak","said ""fine""\nthen left",120\nLamp,,=B2*2\rEnd,"",\n';
const all = (read: SheetRead) => (read.open ? [...read.rows, read.open] : read.rows);

describe('a spreadsheet read as it is written', () => {
  it('reads quotes, escaped quotes, commas and line breaks inside cells, and every line end', () => {
    expect(all(readSheet(CSV))).toEqual([
      ['Item', 'Note', 'Cost'],
      ['Desk, oak', 'said "fine"\nthen left', '120'],
      ['Lamp', '', '=B2*2'],
      ['End', '', ''],
    ]);
  });

  it('comes out the same however the text arrived, a character at a time included', () => {
    const whole = all(readSheet(CSV));
    for (const size of [1, 2, 3, 7, 16]) {
      let read: SheetRead | undefined;
      for (let at = size; at < CSV.length + size; at += size) {
        read = readSheet(CSV.slice(0, at), read);
      }
      expect(all(read as SheetRead), `by ${size}`).toEqual(whole);
    }
  });

  it('says which cell is being written, and none just after a row ends', () => {
    expect(readSheet('A,B\n1,"tw').open).toEqual(['1', 'tw']);
    expect(readSheet('A,B\n').open).toBeUndefined();
    // A quote last of all may be the first of an escaped one: the cell stays open.
    expect(readSheet('"a"').open).toEqual(['a']);
    expect(all(readSheet('"a""b"'))).toEqual([['a"b']]);
  });

  it('reads a text that is not the last one continued from the start', () => {
    const before = readSheet('A,B\n1,2\n');
    expect(all(readSheet('X,Y\n', before))).toEqual([['X', 'Y']]);
  });

  it('names columns as a sheet does', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });
});
