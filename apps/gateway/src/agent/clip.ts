/**
 * Characters kept of each stream, its first and last halves; a command that prints a megabyte
 * would cost the run its context. The result's own budget then cuts what is kept further.
 */
export const MAX_OUTPUT = 60_000;

/**
 * Its first and last halves within `limit`: a build or a test run says what failed at the end,
 * and the start says what ran. What is cut here is gone, not stored, and the marker says so, in
 * the form Jian Remote writes (its `ends.ts`), which `results.ts` reads for the real size.
 */
export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const end = whole(text, half);
  const start = whole(text, text.length - half);
  const dropped = text.slice(end, start);
  const lines = dropped.split('\n').length - 1;
  return `${text.slice(0, end)}\n[… ${lines.toLocaleString('en')} lines (${dropped.length.toLocaleString('en')} characters) of this output were not kept]\n${text.slice(start)}`;
}

/** An index moved off the middle of a surrogate pair, so no half of a character is kept. */
function whole(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return index > 0 && index < text.length && code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}
