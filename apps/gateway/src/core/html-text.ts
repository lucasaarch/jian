const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Lower case in ASCII alone, so every index in it is the same index in the original. */
const asciiLower = (text: string) => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

/**
 * `text` without the spans from an `opener` to its closing mark, each replaced by a space.
 *
 * The page is whoever wrote it, and it is read on the main thread: a lazy regex retries from every
 * opener that has no closer, so 200 KB of them held the event loop for seconds and the 5 MB a page
 * may have, for hours. Here a closer once missing is never looked for again, which keeps the
 * whole pass linear.
 */
function withoutSpans(
  text: string,
  opener: RegExp,
  closerOf: (name: string) => string,
  once = false,
): string {
  const lower = asciiLower(text);
  const missing = new Set<string>();
  const kept: string[] = [];
  let from = 0;

  for (let open = opener.exec(text); open; open = opener.exec(text)) {
    const closer = closerOf(open[1]?.toLowerCase() ?? '');
    if (missing.has(closer)) continue;

    const at = lower.indexOf(closer, open.index + open[0].length);
    if (at < 0) {
      missing.add(closer);
      continue;
    }

    kept.push(text.slice(from, open.index), ' ');
    from = at + closer.length;
    opener.lastIndex = from;
    if (once) break;
  }

  kept.push(text.slice(from));
  return kept.join('');
}

/** Each `opener` through the next `>`, replaced. With no `>` left, nothing later can match. */
function replacingTags(text: string, opener: RegExp, replacement: string): string {
  const kept: string[] = [];
  let from = 0;

  for (let open = opener.exec(text); open; open = opener.exec(text)) {
    const end = text.indexOf('>', open.index + open[0].length);
    if (end < 0) break;

    kept.push(text.slice(from, open.index), replacement);
    from = end + 1;
    opener.lastIndex = from;
  }

  kept.push(text.slice(from));
  return kept.join('');
}

/** What the first `<title>` holds. If it has no closer, no later one can have one either. */
function titleOf(html: string): string | undefined {
  const lower = asciiLower(html);
  const open = lower.indexOf('<title');
  const body = open < 0 ? -1 : lower.indexOf('>', open + '<title'.length);
  const close = body < 0 ? -1 : lower.indexOf('</title>', body + 1);

  return close < 0 ? undefined : html.slice(body + 1, close);
}

/**
 * A page as the text a person reads: scripts, styles and markup gone, block elements kept as
 * line breaks. Not a browser — a page that builds itself in JavaScript reads as nearly empty.
 */
export function pageText(html: string): { title?: string; text: string } {
  const title = titleOf(html);
  const decode = (value: string) =>
    value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code: string) => {
      if (code.startsWith('#')) {
        const point =
          code[1]?.toLowerCase() === 'x'
            ? Number.parseInt(code.slice(2), 16)
            : Number(code.slice(1));

        return Number.isFinite(point) && point > 0 && point < 0x110000
          ? String.fromCodePoint(point)
          : entity;
      }

      return ENTITIES[code.toLowerCase()] ?? entity;
    });

  const noHead = withoutSpans(html, /<head[\s>]/gi, () => '</head>', true);
  const noCode = withoutSpans(
    noHead,
    /<(script|style|noscript|svg|template)/gi,
    (name) => `</${name}>`,
  );
  const noComments = withoutSpans(noCode, /<!--/g, () => '-->');
  const broken = replacingTags(
    noComments,
    /<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)/gi,
    '\n',
  );
  const text = decode(replacingTags(broken, /<(?!>)/g, ' '))
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();

  return { ...(title ? { title: decode(title).trim() } : {}), text };
}
