import { createContext, Fragment, memo, type ReactNode, useContext } from 'react';
import { CodeBlock } from './code-block';

/**
 * What a page shows in place of a link it knows more about, such as a pull request's card.
 * Undefined keeps the plain link; without a provider every link is plain.
 */
export const MarkdownLinks = createContext<
  ((href: string, label: string) => ReactNode | undefined) | undefined
>(undefined);

/**
 * How a page shows the pictures in its text. Without it they stay text: an agent's answer or a
 * skill never makes the app fetch an address someone else wrote, which would tell them it was read.
 */
export const MarkdownImages = createContext<((src: string, alt: string) => ReactNode) | undefined>(
  undefined,
);

function MarkdownImage({ text, alt, src }: { text: string; alt: string; src: string }) {
  const drawn = useContext(MarkdownImages)?.(src, alt);
  if (drawn) return drawn;
  // As it read before pictures were known: a link with its mark, or the words as written.
  return /^https?:\/\//.test(src) ? (
    <>
      !<MarkdownLink href={src} label={alt || src} />
    </>
  ) : (
    text
  );
}

/** A link as the page around it chooses to show it, or as a plain one. */
export function MarkdownLink({ href, label }: { href: string; label: string }) {
  const custom = useContext(MarkdownLinks)?.(href, label);

  return (
    custom ?? (
      <a className="text-link" href={href} target="_blank" rel="noreferrer">
        {label}
      </a>
    )
  );
}

/**
 * The Markdown release notes, skills and the agent's answers use — headings, lists, paragraphs,
 * quotes, tables, code blocks, bold, italics, code and links — built as elements rather than
 * injected as HTML, so no text can carry markup into the panel.
 */
/** Stable keys from the content itself; a repeated line gets its occurrence appended. */
function keyed(items: string[], stable = false): Array<[string, string]> {
  const counts = new Map<string, number>();

  return items.map((item, index) => {
    const count = (counts.get(item) ?? 0) + 1;

    counts.set(item, count);

    return [stable ? String(index) : `${item}#${count}`, item];
  });
}

/**
 * What a half-written text should show: an open code fence is closed so its lines already read
 * as code, and one unfinished opening marker at the very end is hidden until its closing mark
 * arrives. Only text after the last token `inline` recognises can hold one, so closed code,
 * emphasis, links and URLs are never touched and settled text does not change under the reader.
 */
export function streamable(text: string): string {
  const fences = text.match(/^```/gm)?.length ?? 0;

  if (fences % 2) return `${text.endsWith('\n') ? text : `${text}\n`}\`\`\``;

  const start = text.lastIndexOf('\n') + 1;
  const line = text.slice(start);

  if (line.startsWith('```')) return text;

  let from = 0;

  for (const match of line.matchAll(inlinePattern)) from = (match.index ?? 0) + match[0].length;

  // An opener follows the start, a space or punctuation, and is followed by text or nothing yet.
  const openers = [...line.slice(from).matchAll(/(?<![^\s\p{P}])(\*\*|\*|_|`)(?=\S|$)/gu)];
  const opener = openers.at(-1);

  if (!opener) return text;

  const at = from + (opener.index ?? 0);
  const marker = opener[1] ?? '';

  // A later copy of the mark means it closes something; leave it to the renderer.
  if (line.slice(at + marker.length).includes(marker)) return text;

  return text.slice(0, start + at) + text.slice(start + at + marker.length);
}

/** Every inline token the renderer knows; `streamable` reads the same one. */
const inlinePattern =
  /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(?<![\w*])[*_]([^*_\s](?:[^*_]*[^*_\s])?)[*_](?![\w*])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|!\[([^\]]*)\]\(([^)\s]+)\)/g;

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;

  for (const match of text.matchAll(inlinePattern)) {
    const at = match.index ?? 0;

    if (at > last) parts.push(<Fragment key={`text-${last}`}>{text.slice(last, at)}</Fragment>);

    if (match[1]) parts.push(<strong key={at}>{inline(match[1])}</strong>);
    else if (match[2]) parts.push(<code key={at}>{match[2]}</code>);
    else if (match[5]) parts.push(<em key={at}>{match[5]}</em>);
    else if (match[8])
      parts.push(<MarkdownImage key={at} text={match[0]} alt={match[7] ?? ''} src={match[8]} />);
    else {
      const href = match[4] ?? match[6] ?? '';

      parts.push(<MarkdownLink key={at} href={href} label={match[3] ?? href} />);
    }

    last = at + match[0].length;
  }

  if (last < text.length) parts.push(<Fragment key={`text-${last}`}>{text.slice(last)}</Fragment>);

  return parts;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

/** A header row, a `|---|` rule, then rows: the table every model writes. */
function table(lines: string[]) {
  if (lines.length < 2 || !lines.every((line) => line.trim().startsWith('|'))) return undefined;
  if (!/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[1] ?? '')) return undefined;

  return { head: cells(lines[0] ?? ''), rows: lines.slice(2).map(cells) };
}

/** The text between code fences, and what is left around them, in order. */
function segments(text: string): Array<{ code: boolean; text: string; language?: string }> {
  const parts: Array<{ code: boolean; text: string; language?: string }> = [];
  let last = 0;

  for (const match of text.matchAll(/^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm)) {
    const at = match.index ?? 0;
    // The fence's first word names the language: ```ts, ```python title="x".
    const language = match[1]?.trim().split(/\s+/)[0]?.toLowerCase() || undefined;

    if (at > last) parts.push({ code: false, text: text.slice(last, at) });
    parts.push({
      code: true,
      text: match[2]?.replace(/\n$/, '') ?? '',
      ...(language ? { language } : {}),
    });
    last = at + match[0].length;
  }

  if (last < text.length) parts.push({ code: false, text: text.slice(last) });

  return parts;
}

const bullet = /^\s*[-*]\s+/;
const numbered = /^\s*\d+[.)]\s+/;

function list(lines: string[], marker: RegExp) {
  // A continuation line belongs to the item above it.
  return lines.reduce<string[]>((all, line) => {
    if (marker.test(line)) all.push(line.replace(marker, ''));
    else all[all.length - 1] = `${all.at(-1) ?? ''} ${line.trim()}`;

    return all;
  }, []);
}

type Kind = 'heading' | 'bullet' | 'numbered' | 'table' | 'quote' | 'text';

const kindOf = (line: string): Kind =>
  /^#{1,6}\s/.test(line)
    ? 'heading'
    : bullet.test(line)
      ? 'bullet'
      : numbered.test(line)
        ? 'numbered'
        : line.trim().startsWith('|')
          ? 'table'
          : line.startsWith('>')
            ? 'quote'
            : 'text';

/**
 * Models often start a list, a table or a heading on the line right under a sentence. A blank
 * line is put wherever the kind of line changes, so each becomes its own block; an indented
 * line stays with the item above it.
 */
function separated(text: string) {
  let previous: Kind | undefined;

  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) {
        previous = undefined;
        return line;
      }

      if (/^\s{2,}\S/.test(line) && (previous === 'bullet' || previous === 'numbered')) return line;

      const kind = kindOf(line);
      const apart = previous && (kind !== previous || kind === 'heading');

      previous = kind;

      return apart ? `\n${line}` : line;
    })
    .join('\n');
}

const Blocks = memo(function Blocks({
  text,
  breaks,
  streaming,
}: {
  text: string;
  breaks: boolean;
  streaming: boolean;
}) {
  const blocks = separated(text)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return (
    <>
      {keyed(blocks, streaming).map(([key, block]) => {
        const heading = /^(#{1,6})\s+(.*)$/.exec(block);

        if (heading) {
          return heading[1] === '#' || heading[1] === '##' ? (
            <h3 key={key}>{inline(heading[2] ?? '')}</h3>
          ) : (
            <h4 key={key}>{inline(heading[2] ?? '')}</h4>
          );
        }

        const lines = block.split('\n');
        const grid = table(lines);

        if (grid) {
          return (
            <div key={key} className="markdown-table">
              <table>
                <thead>
                  <tr>
                    {keyed(grid.head, streaming).map(([cellKey, cell]) => (
                      <th key={cellKey}>{inline(cell)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {keyed(
                    grid.rows.map((row) => row.join('|')),
                    streaming,
                  ).map(([rowKey], index) => (
                    <tr key={rowKey}>
                      {keyed(grid.rows[index] ?? [], streaming).map(([cellKey, cell]) => (
                        <td key={cellKey}>{inline(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(block)) {
          return <hr key={key} />;
        }
        const continued = (line: string) => /^\s{2,}\S/.test(line);

        if (lines.every((line) => bullet.test(line) || continued(line))) {
          return (
            <ul key={key}>
              {keyed(list(lines, bullet), streaming).map(([itemKey, item]) => (
                <li key={itemKey}>{inline(item)}</li>
              ))}
            </ul>
          );
        }

        if (lines.every((line) => numbered.test(line) || continued(line))) {
          return (
            <ol key={key}>
              {keyed(list(lines, numbered), streaming).map(([itemKey, item]) => (
                <li key={itemKey}>{inline(item)}</li>
              ))}
            </ol>
          );
        }

        if (lines.every((line) => line.startsWith('>'))) {
          return (
            <blockquote key={key}>
              {inline(lines.map((line) => line.replace(/^>\s?/, '')).join(' '))}
            </blockquote>
          );
        }

        return (
          <p key={key}>
            {keyed(lines, streaming).map(([lineKey, line], position) => (
              <Fragment key={lineKey}>
                {position > 0 && (breaks ? <br /> : ' ')}
                {inline(line)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
});

/** A code segment is highlighted again only when its own text changes, not when a sibling grows. */
const CodeSegment = memo(function CodeSegment({ part }: { part: string }) {
  const head = part.indexOf('\n');

  return <CodeBlock text={part.slice(head + 1)} language={part.slice(3, head) || undefined} />;
});

/**
 * `breaks` keeps a single line break as one, the way a chat reads; documents join the lines of
 * a paragraph, the way Markdown does. Drawn again only when its text or options change: a long
 * conversation redraws on every step of a turn, and each of its messages would be parsed and
 * highlighted again for nothing. Links and pictures still follow their providers.
 */
export const Markdown = memo(function Markdown({
  text,
  breaks = false,
  streaming = false,
}: {
  text: string;
  breaks?: boolean;
  streaming?: boolean;
}) {
  const shown = streaming ? streamable(text) : text;

  return (
    <>
      {keyed(
        segments(shown).map((part) =>
          part.code ? `\`\`\`${part.language ?? ''}\n${part.text}` : part.text,
        ),
        streaming,
      ).map(([key, part]) =>
        part.startsWith('```') ? (
          <CodeSegment key={key} part={part} />
        ) : (
          <Blocks key={key} text={part} breaks={breaks} streaming={streaming} />
        ),
      )}
    </>
  );
});

/** The words of a Markdown text on one line, for a preview: marks, fences and pipes gone. */
export function plainText(text: string) {
  return text
    .replace(/```[^\n]*\n?/g, '')
    .replace(/^\s*(#{1,6}|>|[-*]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{2,}[-|:\s]*$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|`|\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
