/**
 * The HTML part of an outgoing email, drawn from the Markdown the agent writes. Only what is
 * built here reaches the HTML: every character of the agent's text is escaped first, links keep
 * http, https and mailto alone, and no tag, image, style or script of the agent's passes through.
 * The styles are the gateway's own, inline, because mail clients drop a `<style>` block. Nothing
 * tracks a reader: no remote image, no rewritten link.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const LINE = '#d0d7de';
const SHADE = '#f6f8fa';

const STYLE = {
  body: `max-width:640px;padding:16px;font-family:${FONT};font-size:15px;line-height:1.5;color:#1f2328`,
  p: 'margin:0 0 12px',
  heading: 'margin:16px 0 8px;font-weight:600;line-height:1.3',
  list: 'margin:0 0 12px;padding-left:24px',
  item: 'margin:0 0 4px',
  pre: `margin:0 0 12px;padding:12px;background:${SHADE};border-radius:6px;font-family:${MONO};font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word`,
  code: `font-family:${MONO};font-size:13px;background:${SHADE};padding:1px 4px;border-radius:4px`,
  quote: `margin:0 0 12px;padding:0 12px;border-left:3px solid ${LINE};color:#57606a`,
  rule: `border:0;border-top:1px solid ${LINE};margin:16px 0`,
  table: 'border-collapse:collapse;margin:0 0 12px',
  cell: `border:1px solid ${LINE};padding:4px 8px;text-align:left;vertical-align:top`,
  link: 'color:#0969da',
};

/** By heading level, 1 to 6: past the third they stop growing and read as bold lines. */
const HEADING_SIZES = ['22px', '19px', '17px', '15px', '15px', '15px'];

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);

/** The schemes a reader may follow; anything else, `javascript:` first, keeps its words only. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function safeHref(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return SAFE_SCHEMES.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bold, italic and struck text, over text already escaped: the marks are characters escaping
 * leaves alone, and each becomes a fixed tag around what was escaped.
 */
const emphasis = (html: string) =>
  html
    .replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '<strong>$2</strong>')
    .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '<em>$1</em>')
    .replace(/(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])/g, '<em>$1</em>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>');

/** An inline code span, a `[words](url)` link, or a bare web address, in that order. */
const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(\s*<?([^()<>\s]+)>?\s*\)|(https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]])/g;

const anchor = (href: string, label: string) =>
  `<a href="${escapeHtml(href)}" style="${STYLE.link}">${label}</a>`;

function inline(text: string): string {
  let html = '';
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    html += emphasis(escapeHtml(text.slice(last, match.index)));
    const [whole, code, label, target, bare] = match;
    if (code !== undefined) html += `<code style="${STYLE.code}">${escapeHtml(code)}</code>`;
    else if (label !== undefined) {
      const href = safeHref(target ?? '');
      const words = emphasis(escapeHtml(label));
      html += href ? anchor(href, words) : words;
    } else if (bare !== undefined) {
      const href = safeHref(bare);
      html += href ? anchor(href, escapeHtml(bare)) : escapeHtml(bare);
    }
    last = match.index + whole.length;
  }
  return html + emphasis(escapeHtml(text.slice(last)));
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isTableDivider = (line: string) => /^\s*\|[\s:|-]+\|\s*$/.test(line);
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|');

const LIST_ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const HEADING = /^\s*(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

function blocks(lines: string[]): string[] {
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p style="${STYLE.p}">${paragraph.join('<br>')}</p>`);
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] as string).trim().startsWith(fence[1] ?? ''))
        code.push(lines[index++] as string);
      out.push(`<pre style="${STYLE.pre}">${escapeHtml(code.join('\n'))}</pre>`);
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1]?.length ?? 1;
      const size = HEADING_SIZES[level - 1];
      out.push(
        `<h${level} style="${STYLE.heading};font-size:${size}">${inline(heading[2] ?? '')}</h${level}>`,
      );
      continue;
    }

    if (RULE.test(line)) {
      flush();
      out.push(`<hr style="${STYLE.rule}">`);
      continue;
    }

    if (isTableRow(line) && isTableDivider(lines[index + 1] ?? '')) {
      flush();
      const head = cells(line)
        .map((cell) => `<th style="${STYLE.cell}">${inline(cell.trim())}</th>`)
        .join('');
      const rows: string[] = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index] as string)) {
        const row = cells(lines[index++] as string)
          .map((cell) => `<td style="${STYLE.cell}">${inline(cell.trim())}</td>`)
          .join('');
        rows.push(`<tr>${row}</tr>`);
      }
      index -= 1;
      out.push(
        `<table style="${STYLE.table}"><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`,
      );
      continue;
    }

    if (/^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] as string))
        quoted.push((lines[index++] as string).replace(/^\s*>\s?/, ''));
      index -= 1;
      out.push(`<blockquote style="${STYLE.quote}">${blocks(quoted).join('')}</blockquote>`);
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1] ?? '');
      const start = ordered ? Number.parseInt(item[1] ?? '1', 10) : 1;
      const items: string[] = [];
      // One level: a nested item joins the list it is under, and an indented line continues
      // the item above it.
      while (index < lines.length) {
        const current = lines[index] as string;
        const next = LIST_ITEM.exec(current);
        if (next && /\d/.test(next[1] ?? '') === ordered) items.push(inline(next[2] ?? ''));
        else if (!next && /^\s+\S/.test(current) && items.length)
          items[items.length - 1] += `<br>${inline(current.trim())}`;
        else break;
        index += 1;
      }
      index -= 1;
      const tag = ordered ? 'ol' : 'ul';
      const from = ordered && start !== 1 ? ` start="${start}"` : '';
      const body = items.map((entry) => `<li style="${STYLE.item}">${entry}</li>`).join('');
      out.push(`<${tag}${from} style="${STYLE.list}">${body}</${tag}>`);
      continue;
    }

    paragraph.push(inline(line.trim()));
  }

  flush();
  return out;
}

/** The whole HTML document of an email whose text is this Markdown. */
export function emailHtml(markdown: string): string {
  const body = blocks(markdown.replace(/\r\n?/g, '\n').split('\n')).join('\n');
  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>',
    `<body style="margin:0;padding:0;background:#ffffff"><div style="${STYLE.body}">`,
    body,
    '</div></body></html>',
  ].join('\n');
}
