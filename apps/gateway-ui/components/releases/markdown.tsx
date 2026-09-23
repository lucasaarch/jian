import { Fragment, type ReactNode } from 'react';

/**
 * The little Markdown a release note uses — headings, lists, paragraphs, bold, code and links —
 * built as elements rather than injected as HTML, so a note can never carry markup into the
 * panel.
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

export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).map((block) => block.trim());

  return (
    <>
      {keyed(blocks).map(([key, block]) => {
        const heading = /^(#{2,4})\s+(.*)$/.exec(block);

        if (heading) {
          return <h3 key={key}>{inline(heading[2] ?? '')}</h3>;
        }

        const lines = block.split('\n');

        if (lines.every((line) => /^\s*[-*]\s+/.test(line) || /^\s{2,}\S/.test(line))) {
          // A continuation line belongs to the item above it.
          const items = lines.reduce<string[]>((all, line) => {
            if (/^\s*[-*]\s+/.test(line)) all.push(line.replace(/^\s*[-*]\s+/, ''));
            else all[all.length - 1] = `${all.at(-1) ?? ''} ${line.trim()}`;

            return all;
          }, []);

          return (
            <ul key={key}>
              {keyed(items).map(([itemKey, item]) => (
                <li key={itemKey}>{inline(item)}</li>
              ))}
            </ul>
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
