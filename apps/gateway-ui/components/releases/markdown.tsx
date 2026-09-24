import { Fragment, type ReactNode } from 'react';

/**
 * The little Markdown release notes and skills use — headings, lists, paragraphs, quotes, code
 * blocks, bold, code and links — built as elements rather than injected as HTML, so a note can
 * never carry markup into the panel.
 */
/** Stable keys from the content itself; a repeated line gets its occurrence appended. */
function keyed(items: string[]): Array<[string, string]> {
  const counts = new Map<string, number>();

  return items.map((item) => {
    const count = (counts.get(item) ?? 0) + 1;

    counts.set(item, count);

    return [`${item}#${count}`, item];
  });
}

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;

    if (at > last) parts.push(text.slice(last, at));

    if (match[1]) parts.push(<strong key={at}>{match[1]}</strong>);
    else if (match[2]) parts.push(<code key={at}>{match[2]}</code>);
    else
      parts.push(
        <a key={at} href={match[4]} target="_blank" rel="noreferrer">
          {match[3]}
        </a>,
      );

    last = at + match[0].length;
  }

  if (last < text.length) parts.push(text.slice(last));

  return parts;
}

/** The text between code fences, and what is left around them, in order. */
function segments(text: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  let last = 0;

  for (const match of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)) {
    const at = match.index ?? 0;

    if (at > last) parts.push({ code: false, text: text.slice(last, at) });
    parts.push({ code: true, text: match[1]?.replace(/\n$/, '') ?? '' });
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

function Blocks({ text }: { text: string }) {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return (
    <>
      {keyed(blocks).map(([key, block]) => {
        const heading = /^(#{1,6})\s+(.*)$/.exec(block);

        if (heading) {
          return <h3 key={key}>{inline(heading[2] ?? '')}</h3>;
        }

        const lines = block.split('\n');
        const continued = (line: string) => /^\s{2,}\S/.test(line);

        if (lines.every((line) => bullet.test(line) || continued(line))) {
          return (
            <ul key={key}>
              {keyed(list(lines, bullet)).map(([itemKey, item]) => (
                <li key={itemKey}>{inline(item)}</li>
              ))}
            </ul>
          );
        }

        if (lines.every((line) => numbered.test(line) || continued(line))) {
          return (
            <ol key={key}>
              {keyed(list(lines, numbered)).map(([itemKey, item]) => (
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
            {keyed(lines).map(([lineKey, line], position) => (
              <Fragment key={lineKey}>
                {position > 0 && ' '}
                {inline(line)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <>
      {keyed(segments(text).map((part) => `${part.code ? '```' : ''}${part.text}`)).map(
        ([key, part]) =>
          part.startsWith('```') ? (
            <pre key={key}>
              <code>{part.slice(3)}</code>
            </pre>
          ) : (
            <Blocks key={key} text={part} />
          ),
      )}
    </>
  );
}
