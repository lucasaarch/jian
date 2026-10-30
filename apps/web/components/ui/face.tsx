/**
 * A person or a group: the picture it uses on its channel, or its initials in the same circle,
 * so a row lines up the same whether or not the picture has arrived.
 */
export function Face({
  name,
  picture,
  className = '',
}: {
  name: string;
  picture?: string | undefined;
  className?: string;
}) {
  if (picture) {
    // biome-ignore lint/performance/noImgElement: a data URL from the gateway; nothing to optimise.
    return <img className={`face ${className}`} src={picture} alt="" />;
  }

  const initials =
    name
      .replace(/^(WhatsApp|Telegram)\s·\s/, '')
      .split(/\s+/)
      .filter((word) => /\p{L}/u.test(word))
      .slice(0, 2)
      .map((word) => word.match(/\p{L}/u)?.[0]?.toUpperCase())
      .join('') || '#';

  return (
    <span className={`face ${className}`} aria-hidden="true">
      {initials}
    </span>
  );
}
