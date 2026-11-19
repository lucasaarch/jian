import { mediaMimeOf } from '@jian/contracts';

/**
 * How a linked file is answered. The file is served at the gateway's own address, so whatever it
 * holds must never run there: every answer is `nosniff` under a policy that loads nothing and
 * sandboxes the document, and only pictures, sound and video are shown in the browser. Anything
 * else, a page or a script among them, is saved as a download.
 */

/** Media a browser shows by itself; everything else is an attachment. */
const SHOWN = /^(image|audio|video)\//;

/** The file's type from its extension; one nobody names is plain bytes. */
export const typeOf = (name: string): string => mediaMimeOf(undefined, name);

/** A file name with nothing but letters, digits, dots, dashes and underscores, as ASCII. */
export function plainName(name: string): string {
  const plain = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    // A leading dot would hide the file where it is saved.
    .replace(/^[-.]+/, '')
    .replace(/-+(\.[A-Za-z0-9]+)?$/, '$1');
  if (!plain || plain.startsWith('.')) return 'file';
  if (plain.length <= 100) return plain;
  const extension = /\.[A-Za-z0-9]{1,10}$/.exec(plain)?.[0] ?? '';
  return `${plain.slice(0, 100 - extension.length)}${extension}`;
}

/** RFC 8187: what `encodeURIComponent` leaves of these is not allowed in an extended value. */
const extended = (value: string) =>
  encodeURIComponent(value).replace(
    /['()*!]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * `inline` for media, `attachment` for the rest, with the name twice: an ASCII one any client
 * reads, and the real one for those that read RFC 8187. Quotes, backslashes, separators and
 * control characters never reach either, so no name can end the header or add a field to it.
 */
export function disposition(name: string, type: string): string {
  const kind = SHOWN.test(type) ? 'inline' : 'attachment';
  const clean =
    name
      .normalize('NFC')
      .replace(/[\p{Cc}\p{Cf}"\\/]/gu, '')
      .trim() || 'file';
  return `${kind}; filename="${plainName(clean)}"; filename*=UTF-8''${extended(clean)}`;
}

/**
 * The one byte range asked for, inclusive, or undefined to send the whole file: no header, a
 * malformed one, or several ranges, which a server may answer whole. `unsatisfiable` is a range
 * that starts past the end, which is answered 416.
 */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = header ? /^bytes=(\d{0,16})-(\d{0,16})$/.exec(header.trim()) : null;
  if (!match) return undefined;
  const [, first = '', last = ''] = match;
  if (!first && !last) return undefined;
  if (!first) {
    const suffix = Number(last);
    return suffix === 0 ? 'unsatisfiable' : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return 'unsatisfiable';
  const end = last ? Math.min(Number(last), size - 1) : size - 1;
  return end < start ? undefined : { start, end };
}

/** A validator that changes whenever the file served does. */
export const entityTag = (bytes: number, modifiedMs: number) =>
  `"${bytes.toString(36)}-${modifiedMs.toString(36)}"`;

/**
 * Kept privately for at most an hour and never past the link's end, so a revoked link soon stops
 * answering from a cache too.
 */
export function cacheControl(expiresAt: Date, now: number): string {
  const seconds = Math.max(0, Math.min(3600, Math.floor((expiresAt.getTime() - now) / 1000)));
  return `private, max-age=${seconds}`;
}
