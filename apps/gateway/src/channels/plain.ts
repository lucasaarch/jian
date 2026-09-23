/**
 * Markdown as plain text, for the bubbles that do not render it. WhatsApp and Telegram both
 * receive the answer literally, so a table arrives as pipes and `**bold**` as asterisks — noise
 * in place of the formatting the model intended.
 *
 * This is the floor, not the fix: the model is told to write for the channel. Here the rule is
 * enforced anyway, because one stray table is worse than any prompt is reliable.
 */
export function plainText(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;

    if (isTableRow(line) && isTableDivider(lines[index + 1] ?? '')) {
      const header = cells(line);
      let cursor = index + 2;

      // The whole table is one message. A blank line between rows would make each one its own
      // message, so a table of twelve rows became twelve notifications.
      const rows: string[] = [];

      while (cursor < lines.length && isTableRow(lines[cursor] as string)) {
        rows.push(row(header, cells(lines[cursor] as string)).join('\n'));
        cursor += 1;
      }

      out.push(rows.join('\n—\n'), '');

      index = cursor - 1;
      continue;
    }

    out.push(inline(line));
  }

  // Fences leave their own blank lines behind; more than one in a row reads as a gap.
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);

const isTableDivider = (line: string) => /^\s*\|[\s:|-]+\|\s*$/.test(line);

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => inline(cell).trim());

/**
 * One row as its own small block: the first cell names it and the rest are labelled by their
 * column. A row read aloud is what a table is for, and it is all a phone can show.
 */
function row(header: string[], values: string[]): string[] {
  const [first, ...rest] = values;
  const block = [first ?? ''];

  for (const [index, value] of rest.entries()) {
    if (!value) {
      continue;
    }

    const label = header[index + 1];

    block.push(label ? `${label}: ${value}` : value);
  }

  return block.filter(Boolean);
}

function inline(line: string): string {
  return (
    line
      // A fence carries nothing on its own; the code inside it stays.
      .replace(/^\s*```.*$/, '')
      .replace(/^\s*#{1,6}\s+/, '')
      // A quote marker is punctuation the bubble does not draw.
      .replace(/^\s*>\s?/, '')
      .replace(/^(\s*)[-*+]\s+/, '$1• ')
      .replace(/^\s*([-*_])\s*\1\s*\1[\s*_-]*$/, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) =>
        text === url ? url : `${text}: ${url}`,
      )
      .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1')
      .replace(/(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w_])/g, '$1')
      .replace(/`{1,3}([^`\n]+)`{1,3}/g, '$1')
  );
}
