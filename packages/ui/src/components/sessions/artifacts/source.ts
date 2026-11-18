import { toast } from 'sonner';
import type { SessionArtifact } from '../../../lib/api';

type Kind = SessionArtifact['type'];

/** Each type as the owner reads it in the list. */
export const TYPE_NAME: Record<Kind, string> = {
  html: 'Web page',
  react: 'React component',
  markdown: 'Document',
  svg: 'Picture',
  mermaid: 'Diagram',
  deck: 'Deck',
  // What a file of no known format is called; one of a known format goes by it (kind.tsx).
  file: 'File',
};

/** The highlighter's grammar for a type's source; a diagram's has none. A deck's is a slide's. */
export const LANGUAGE: Partial<Record<Kind, string>> = {
  html: 'xml',
  react: 'typescript',
  markdown: 'markdown',
  svg: 'xml',
  deck: 'xml',
};

const EXTENSION: Record<Kind, string> = {
  html: 'html',
  react: 'tsx',
  markdown: 'md',
  svg: 'svg',
  mermaid: 'mmd',
  // A deck is read, copied and downloaded one slide at a time, and a slide is a page.
  deck: 'html',
  // Never asked for: a file is downloaded under its own name (file-view.tsx).
  file: 'bin',
};

/**
 * The file a version downloads as: its title in words a file system takes, its version, and
 * for a deck the number of the slide it is. `extension` is for a deck drawn into another kind
 * of file than its source's.
 */
export function fileName(
  artifact: Pick<SessionArtifact, 'title' | 'type'>,
  version: number,
  slide?: number,
  extension: string = EXTENSION[artifact.type],
) {
  const name = artifact.title
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return `${name || 'artifact'}-v${version}${slide ? `-slide-${slide}` : ''}.${extension}`;
}

/** A file the gateway answered in base64, as the browser saves one. */
export const fileOf = ({ mimeType, data }: { mimeType: string; data: string }) =>
  new Blob([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], { type: mimeType });

/** Saves text, or a file already made, from an address only this page can make. */
export function download(name: string, content: string | Blob) {
  const url = URL.createObjectURL(
    typeof content === 'string'
      ? new Blob([content], { type: 'text/plain;charset=utf-8' })
      : content,
  );
  const link = document.createElement('a');

  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error(`The ${what.toLowerCase()} could not be copied.`);
  }
}
