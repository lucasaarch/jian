const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * A page as the text a person reads: scripts, styles and markup gone, block elements kept as
 * line breaks. Not a browser — a page that builds itself in JavaScript reads as nearly empty.
 */
export function pageText(html: string): { title?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
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

  const text = decode(
    html
      .replace(/<head[\s>][\s\S]*?<\/head>/i, ' ')
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();

  return { ...(title ? { title: decode(title).trim() } : {}), text };
}
