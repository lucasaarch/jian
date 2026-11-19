import { describe, expect, it } from 'vitest';
import { SHEET_MODEL } from '../src/artifacts/sheet-model.js';

type Model = {
  rows: string[][];
  shifted: (formula: string, axis: 'r' | 'c', at: number, count: number) => string;
  moved: (formula: string, rows: number, columns: number) => string;
  reshape: (axis: 'r' | 'c', at: number, count: number) => void;
  csv: (rows: string[][]) => string;
  shown: (row: number, column: number) => [string, string];
};

/** The model as the frame and the Excel export run it, on a sheet of its own. */
const open = (source: string): Model =>
  new Function(
    'source',
    `${SHEET_MODEL}\nreturn { get rows() { return rows; }, shifted, moved, reshape, csv, shown };`,
  )(source) as Model;

const { shifted, moved } = open('');

describe('formulas when rows and columns move', () => {
  it('follows the cells a row put in above them pushes down', () => {
    expect(shifted('B2*C2', 'r', 1, 1)).toBe('B3*C3');
    expect(shifted('B2*C2', 'r', 2, 1)).toBe('B2*C2');
    expect(shifted('$B$2+B1', 'r', 1, 3)).toBe('$B$5+B1');
  });

  it('grows a range a row is put into, and moves one put in above', () => {
    expect(shifted('SUM(B2:B5)', 'r', 3, 2)).toBe('SUM(B2:B7)');
    expect(shifted('SUM(B2:B5)', 'r', 1, 1)).toBe('SUM(B3:B6)');
    // Just below a range is outside it, as in Excel.
    expect(shifted('SUM(B2:B5)', 'r', 5, 1)).toBe('SUM(B2:B5)');
  });

  it('moves columns the same way', () => {
    expect(shifted('A1+C1&D2', 'c', 1, 1)).toBe('A1+D1&E2');
    expect(shifted('SUM(A1:C1)', 'c', 1, 2)).toBe('SUM(A1:E1)');
  });

  it('turns a reference to a cell taken out into #REF!, and shrinks a range', () => {
    expect(shifted('B2*C3', 'r', 1, -1)).toBe('#REF!*C2');
    expect(shifted('SUM(B2:B6)', 'r', 2, -2)).toBe('SUM(B2:B4)');
    expect(shifted('SUM(B2:B6)', 'r', 0, -3)).toBe('SUM(B1:B3)');
    expect(shifted('SUM(B2:B6)', 'r', 4, -5)).toBe('SUM(B2:B4)');
    expect(shifted('SUM(B2:B3)', 'r', 1, -2)).toBe('SUM(#REF!)');
    expect(shifted('B1', 'c', 1, -1)).toBe('#REF!');
  });

  it('leaves text in quotes, function names and other words alone', () => {
    expect(shifted('"B2 "" A2"&B2', 'r', 0, 1)).toBe('"B2 "" A2"&B3');
    expect(shifted('LOG10(A2)+ABC', 'r', 0, 1)).toBe('LOG10(A3)+ABC');
    expect(shifted('sum(b2:b3)', 'r', 0, 1)).toBe('sum(B3:B4)');
  });

  it('moves what a $ does not hold when a formula is copied', () => {
    expect(moved('A1+$A1+A$1+$A$1', 1, 2)).toBe('C2+$A2+C$1+$A$1');
    expect(moved('SUM(B2:B4)', -1, 0)).toBe('SUM(B1:B3)');
    expect(moved('A1*2', -1, 0)).toBe('#REF!*2');
  });
});

describe('a sheet when rows and columns move', () => {
  it('puts rows in, and every formula still works out the same cells', () => {
    const sheet = open(
      'Item,Qty,Price,Total\nPens,2,3,=B2*C2\nPads,1,4,=B3*C3\nSum,,,=SUM(D2:D3)\n',
    );
    sheet.reshape('r', 2, 1);
    expect(sheet.csv(sheet.rows)).toBe(
      'Item,Qty,Price,Total\nPens,2,3,=B2*C2\n\nPads,1,4,=B4*C4\nSum,,,=SUM(D2:D4)\n',
    );
    expect(sheet.shown(4, 3)[0]).toBe('10');
  });

  it('takes a column out, and a formula that read it says #REF!', () => {
    const sheet = open('1,2,=A1+B1,=C1*2\n');
    sheet.reshape('c', 1, -1);
    expect(sheet.csv(sheet.rows)).toBe('1,=A1+#REF!,=B1*2\n');
    expect(sheet.shown(0, 1)).toEqual(['#REF!', 'error']);
    expect(sheet.shown(0, 2)).toEqual(['#REF!', 'error']);
  });

  it('puts a column in past the end of a short row without padding it', () => {
    const sheet = open('a,b,c\nd\n');
    sheet.reshape('c', 2, 1);
    expect(sheet.csv(sheet.rows)).toBe('a,b,,c\nd\n');
  });
});
