import { createContext, Fragment, type ReactNode, useContext } from 'react';
import { CodeBlock } from './code-block';

/**
 * What a page shows in place of a link it knows more about, such as a pull request's card.
 * Undefined keeps the plain link; without a provider every link is plain.
 */
export const MarkdownLinks = createContext<
  ((href: string, label: string) => ReactNode | undefined) | undefined
>(undefined);

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

/** Word nodes keep their offsets as tokens append; only new nodes animate, with a bounded stagger. */
function words(text: string, streaming: boolean): ReactNode {
  if (!streaming) return text;
  return [...text.matchAll(/\s+|\S+/g)].map((match, index) =>
    /^\s+$/.test(match[0]) ? (
      match[0]
    ) : (
      <span
        key={match.index}
        className="stream-word"
        style={{ animationDelay: `${(Math.floor(index / 2) % 6) * 24}ms` }}
      >
        {match[0]}
      </span>
    ),
  );
}

function inline(text: string, streaming = false): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern =
    /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(?<![\w*])[*_]([^*_\s](?:[^*_]*[^*_\s])?)[*_](?![\w*])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;

    if (at > last)
      parts.push(
        <Fragment key={`text-${last}`}>{words(text.slice(last, at), streaming)}</Fragment>,
      );

    if (match[1]) parts.push(<strong key={at}>{inline(match[1], streaming)}</strong>);
    else if (match[2]) parts.push(<code key={at}>{words(match[2], streaming)}</code>);
    else if (match[5]) parts.push(<em key={at}>{words(match[5], streaming)}</em>);
    else {
      const href = match[4] ?? match[6] ?? '';

      parts.push(<MarkdownLink key={at} href={href} label={match[3] ?? href} />);
    }

    last = at + match[0].length;
  }

  if (last < text.length)
    parts.push(<Fragment key={`text-${last}`}>{words(text.slice(last), streaming)}</Fragment>);

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

function Blocks({
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
            <h3 key={key}>{inline(heading[2] ?? '', streaming)}</h3>
          ) : (
            <h4 key={key}>{inline(heading[2] ?? '', streaming)}</h4>
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
                      <th key={cellKey}>{inline(cell, streaming)}</th>
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
                        <td key={cellKey}>{inline(cell, streaming)}</td>
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
                <li key={itemKey}>{inline(item, streaming)}</li>
              ))}
            </ul>
          );
        }

        if (lines.every((line) => numbered.test(line) || continued(line))) {
          return (
            <ol key={key}>
              {keyed(list(lines, numbered), streaming).map(([itemKey, item]) => (
                <li key={itemKey}>{inline(item, streaming)}</li>
              ))}
            </ol>
          );
        }

        if (lines.every((line) => line.startsWith('>'))) {
          return (
            <blockquote key={key}>
              {inline(lines.map((line) => line.replace(/^>\s?/, '')).join(' '), streaming)}
            </blockquote>
          );
        }

        return (
          <p key={key}>
            {keyed(lines, streaming).map(([lineKey, line], position) => (
              <Fragment key={lineKey}>
                {position > 0 && (breaks ? <br /> : ' ')}
                {inline(line, streaming)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

/**
 * `breaks` keeps a single line break as one, the way a chat reads; documents join the lines of
 * a paragraph, the way Markdown does.
 */
export function Markdown({
  text,
  breaks = false,
  streaming = false,
}: {
  text: string;
  breaks?: boolean;
  streaming?: boolean;
}) {
  return (
    <>
      {keyed(
        segments(text).map((part) =>
          part.code ? `\`\`\`${part.language ?? ''}\n${part.text}` : part.text,
        ),
        streaming,
      ).map(([key, part]) => {
        if (!part.startsWith('```'))
          return <Blocks key={key} text={part} breaks={breaks} streaming={streaming} />;
        const head = part.indexOf('\n');

        return (
          <CodeBlock
            key={key}
            text={part.slice(head + 1)}
            language={part.slice(3, head) || undefined}
          />
        );
      })}
    </>
  );
}

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
