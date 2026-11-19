import { SHEET_MODEL } from './sheet-model.js';

/**
 * A spreadsheet (CSV, formulas starting with `=`) as an Excel file. A formula stays a formula, so
 * Excel and Google Sheets keep working it out, and carries the value the panel shows, so a
 * reader that does not calculate (a preview, a script) still sees numbers. The value comes from
 * the very script the frame draws with (sheet-model.ts), run here with no page.
 */

type Worked = string | number | boolean | { error: string };
type Model = {
  rows: string[][];
  valueAt: (row: number, column: number) => unknown;
  literal: (text: string) => string | number;
  shown: (row: number, column: number) => [string, string];
  quote: (cell: string) => string;
};

/** The frame's reader, run on its own: it holds the CSV and nothing of a page. */
function read(source: string): Model {
  // The script is the gateway's own text. It is never given what the agent wrote as code, only
  // as the data it reads.
  return new Function(
    'source',
    `${SHEET_MODEL}\nreturn { rows: tidy(rows), valueAt, literal, shown, quote };`,
  )(source) as Model;
}

/** Excel's sheet names are at most 31 characters and cannot hold `[]:*?/\`. */
const sheetName = (title: string) =>
  title
    .replace(/[[\]:*?/\\]/g, ' ')
    .trim()
    .slice(0, 31) || 'Sheet1';

/** The values the panel shows, as CSV: what a program that reads no formulas can use. */
export function sheetCsv(source: string): string {
  const model = read(source);
  const lines = model.rows.map((row, r) =>
    row.map((_, c) => model.quote(model.shown(r, c)[0])).join(','),
  );

  return `${lines.join('\n')}\n`;
}

export async function sheetXlsx(title: string, source: string): Promise<Buffer> {
  // Loaded only here: nothing else of the gateway writes Office files.
  const { default: Excel } = await import('exceljs');
  const model = read(source);
  const book = new Excel.Workbook();
  book.creator = 'Jian';
  const sheet = book.addWorksheet(sheetName(title));
  const widths: number[] = [];

  for (const [r, row] of model.rows.entries()) {
    for (const [c, written] of row.entries()) {
      if (written === '') continue;
      const target = sheet.getCell(r + 1, c + 1);
      if (written.startsWith('=')) {
        let result: Worked;
        try {
          result = model.valueAt(r, c) as Worked;
        } catch (error) {
          result = { error: (error as { code?: string }).code ?? '#ERROR!' };
        }
        target.value = {
          formula: written.slice(1),
          result: result as never,
        };
      } else {
        target.value = model.literal(written);
      }
      widths[c] = Math.max(widths[c] ?? 0, Math.min(written.length, 50));
    }
  }
  for (const [c, width] of widths.entries()) {
    if (width) sheet.getColumn(c + 1).width = Math.max(10, width + 2);
  }

  return Buffer.from(await book.xlsx.writeBuffer());
}
