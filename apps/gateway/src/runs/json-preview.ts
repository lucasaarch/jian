/**
 * The start of a JSON text the database cut short, laid out as `JSON.stringify(value, null, 2)`
 * would lay out the whole, so a preview reads like the full step it stands for. What cannot be
 * parsed any more is re-indented token by token; a cut string at the top is shown as its text.
 * The input is the database's own rendering of a JSON value, never arbitrary text.
 */
export function previewJson(cut: string): string {
  if (cut.startsWith('"')) return cutString(cut);

  let text = '';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  const newline = () => `\n${'  '.repeat(depth)}`;

  for (let index = 0; index < cut.length; index++) {
    const char = cut[index] as string;

    if (quoted) {
      text += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      text += char;
    } else if (char === '{' || char === '[') {
      const close = char === '{' ? '}' : ']';
      const next = cut.slice(index + 1).trimStart();
      // An empty object or list stays on its line, as JSON.stringify writes it.
      if (next.startsWith(close)) {
        text += `${char}${close}`;
        index = cut.indexOf(close, index + 1);
        continue;
      }
      depth += 1;
      text += char + newline();
    } else if (char === '}' || char === ']') {
      depth = Math.max(0, depth - 1);
      text += newline() + char;
    } else if (char === ',') {
      text += char + newline();
    } else if (char === ':') {
      text += ': ';
    } else if (!/\s/.test(char)) {
      text += char;
    }
  }

  return text;
}

/** A string value cut short: its text, without the quote and with its escapes read. */
function cutString(cut: string): string {
  // A cut may fall inside an escape; what is left of it is dropped, not shown as a backslash.
  // Backslashes come in pairs when they stand for one: an odd run ends in an escape begun.
  const begun = /(\\+)(u[0-9a-fA-F]{0,3})?$/.exec(cut);
  const whole =
    begun && (begun[1] as string).length % 2
      ? cut.slice(0, begun.index + (begun[1] as string).length - 1)
      : cut;
  // Closed by the cut, or already closed when the value was whole.
  for (const closed of [`${whole}"`, whole]) {
    try {
      const value: unknown = JSON.parse(closed);
      if (typeof value === 'string') return value;
    } catch {
      // Tried the other way, then shown as it stands.
    }
  }
  return cut;
}
