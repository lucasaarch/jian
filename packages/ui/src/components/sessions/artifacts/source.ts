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
};

/** The highlighter's grammar for a type's source; a diagram's has none. */
export const LANGUAGE: Partial<Record<Kind, string>> = {
  html: 'xml',
  react: 'typescript',
  markdown: 'markdown',
  svg: 'xml',
};

const EXTENSION: Record<Kind, string> = {
  html: 'html',
  react: 'tsx',
  markdown: 'md',
  svg: 'svg',
  mermaid: 'mmd',
};

/** The file a version downloads as: its title in words a file system takes, and its version. */
export function fileName(artifact: Pick<SessionArtifact, 'title' | 'type'>, version: number) {
  const name = artifact.title
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return `${name || 'artifact'}-v${version}.${EXTENSION[artifact.type]}`;
}

/** Saves text as a file, from an address only this page can make. */
export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
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
