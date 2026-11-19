import type { PublicArtifactFormat } from '@jian/contracts';
import { GatewayError } from '../core/errors.js';

/**
 * The files a public link offers that are the source as written, by their media type. Text that
 * a browser could draw (`html`) is still only ever answered as an attachment, under a policy that
 * runs nothing (routes.ts).
 */
export const SOURCE_FILES: Partial<Record<PublicArtifactFormat, string>> = {
  html: 'text/html; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  mmd: 'text/plain; charset=utf-8',
};

/** What starts the gateway's browser to be made (export.ts). */
const DRAWN = new Set<PublicArtifactFormat>(['pdf', 'pptx']);

/**
 * At most this many public files are drawn or waiting at once, across every link. The browser
 * draws one file at a time for the owner and readers alike, so the cap keeps a stranger's
 * downloads from making the owner's own wait in a long line, or from holding memory meanwhile.
 */
const DRAWING_MAX = 2;

/** The links whose file is being drawn right now, by their secret. Held in memory only. */
const drawing = new Set<string>();

/**
 * Makes a public file, one at a time per link and `DRAWING_MAX` across them when it takes the
 * browser. Anyone asking for more meanwhile is refused at once rather than queued, and told to
 * try again: a reader clicking twice gets the first file, not two browsers.
 */
export async function drawnInTurn<T>(
  token: string,
  format: PublicArtifactFormat,
  make: () => Promise<T>,
): Promise<T> {
  if (!DRAWN.has(format)) return make();
  if (drawing.has(token) || drawing.size >= DRAWING_MAX) {
    throw new GatewayError(
      429,
      'This file is already being drawn for someone. Try again in a moment.',
    );
  }
  drawing.add(token);
  try {
    return await make();
  } finally {
    drawing.delete(token);
  }
}

/**
 * How a file is named when it is saved: its title in words a file system takes, with the format
 * as its extension. `filename` is plain ASCII for an old client; `filename*` keeps the title's
 * own letters (RFC 6266). Nothing of the title can break out of the header: only letters,
 * numbers and dashes are left of it, and the rest is percent-encoded.
 */
export function attachment(title: string, format: PublicArtifactFormat): string {
  const words = (text: string, dropped: RegExp) =>
    text.replace(dropped, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const name = words(title.normalize('NFC'), /[^\p{L}\p{N}]+/gu) || 'artifact';
  // Accents dropped rather than turned into dashes: "São" is "Sao", not "Sa-o".
  const plain =
    words(name.normalize('NFKD').replace(/\p{M}/gu, ''), /[^A-Za-z0-9]+/g) || 'artifact';

  return `attachment; filename="${plain}.${format}"; filename*=UTF-8''${encodeURIComponent(`${name}.${format}`)}`;
}
