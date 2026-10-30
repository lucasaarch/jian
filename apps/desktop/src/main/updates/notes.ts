/**
 * A release's note, as the update window shows it: the summary on its own, the rest beneath.
 * The note arrives as Markdown when Publish wrote it into the update files, which it does; a
 * release without it falls back to GitHub's feed, which serves the same note rendered as HTML.
 */

/** What electron-updater hands over: one note, or one per release since this one. */
type RawNotes = string | ReadonlyArray<{ version: string; note: string | null }> | null | undefined;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** GitHub's rendering of the note back into the Markdown it came from, near enough to read. */
function fromHtml(html: string): string {
  const markdown = html
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n\n### $1\n\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n* $1')
    .replace(/<\/(ul|ol)>/gi, '\n\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<[^>]+>/g, '');
  return decode(markdown);
}

const isHtml = (text: string) => /<(p|li|h[1-6]|ul|div)\b[^>]*>/i.test(text);

/** The summary — the first paragraph, unless the note opens with a heading or a list — and the rest. */
export function readNotes(raw: RawNotes): { summary: string; notes: string } {
  const text = typeof raw === 'string' ? raw : (raw?.[0]?.note ?? '');
  const markdown = (isHtml(text) ? fromHtml(text) : text).replace(/\r\n/g, '\n').trim();
  const blocks = markdown.split(/\n{2,}/).map((block) => block.trim());
  const [first = '', ...rest] = blocks;
  if (!first || /^(#|[*-] |\d+\. )/.test(first)) return { summary: '', notes: markdown };
  return { summary: first.replace(/\s*\n\s*/g, ' '), notes: rest.filter(Boolean).join('\n\n') };
}
