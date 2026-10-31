/** Continue the list at the caret; an empty item exits it. Keep the text after a selection. */
export function listBreak(text: string, start: number, end: number) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const before = text.slice(lineStart, start);
  const match = /^([\t ]*)(?:(\d+)([.)])|([-+*])) (.*)$/.exec(before);
  if (!match) return null;
  const [, indent, number, delimiter, bullet, content] = match;
  const lineEnd = text.indexOf('\n', end);
  const tail = text.slice(end, lineEnd < 0 ? text.length : lineEnd);
  if (!content?.trim() && !tail.trim()) {
    return {
      text: text.slice(0, lineStart) + indent + text.slice(end),
      caret: lineStart + (indent?.length ?? 0),
    };
  }
  const marker = number ? `${BigInt(number) + 1n}${delimiter}` : bullet;
  const insertion = `\n${indent}${marker} `;
  return {
    text: text.slice(0, start) + insertion + text.slice(end),
    caret: start + insertion.length,
  };
}
