import { MAX_MEDIA_BYTES, MAX_MESSAGE_MEDIA, mediaMimeOf } from '@jian/contracts';

export { MAX_MEDIA_BYTES, MAX_MESSAGE_MEDIA };

/** Past this many characters a paste is a document, not something to type around. */
export const PASTE_AS_FILE_CHARS = 2_000;

export type AttachmentKind = 'image' | 'audio' | 'document';

const images = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const audio = ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'audio/flac'];

/**
 * Text files by extension. Browsers name source files inconsistently (`.ts` arrives as video),
 * so the extension decides, and anything read as text is sent as one of the text types the
 * gateway accepts.
 */
const textExtensions: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  ...Object.fromEntries(
    [
      'txt',
      'log',
      'yaml',
      'yml',
      'toml',
      'ini',
      'xml',
      'html',
      'css',
      'sql',
      'sh',
      'ts',
      'tsx',
      'js',
      'jsx',
      'mjs',
      'py',
      'rb',
      'go',
      'rs',
      'java',
      'kt',
      'swift',
      'c',
      'h',
      'cpp',
      'cs',
      'php',
      'env',
      'graphql',
      'proto',
    ].map((extension) => [extension, 'text/plain']),
  ),
};

/** The type the gateway stores a file under, or why it cannot take it. */
export function classify(file: {
  name: string;
  type: string;
  size: number;
}): { mimeType: string; kind: AttachmentKind } | { error: string } {
  if (file.size === 0) return { error: `${file.name} is empty.` };
  if (file.size > MAX_MEDIA_BYTES) return { error: `${file.name} is larger than 16 MB.` };

  // A recording carries its codec after the type; the gateway stores the container.
  const type = file.type.split(';')[0]?.trim() ?? '';

  if (images.includes(type)) return { mimeType: type, kind: 'image' };
  if (audio.includes(type)) return { mimeType: type, kind: 'audio' };

  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const text = textExtensions[extension];

  if (text) return { mimeType: text, kind: 'document' };

  // Any other file goes as it is; the gateway reads what it can and keeps the rest.
  return { mimeType: mediaMimeOf(type, file.name), kind: 'document' };
}

export async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';

  // In slices: one spread of a 16 MB array overflows the call stack.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return btoa(binary);
}
