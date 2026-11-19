/**
 * Where an imported skill was copied from, in a word or two: a vendor's own catalog by the
 * vendor's name, any other repository by its owner and name, and the host when the address has
 * neither.
 */
export function importedFrom(url: string): string {
  const { pathname, host } = new URL(url);
  const path = pathname.split('/').slice(1, 3).join('/');

  if (path.startsWith('anthropics/')) return 'Anthropic';
  if (path.startsWith('openai/')) return 'OpenAI';

  return path || host;
}

/**
 * An imported skill's address as it is read, not as GitHub writes it: the owner, the repository
 * and the folder, without the branch in between or the document's own name at the end.
 */
export function sourceLabel(url: string): string {
  const { pathname, host } = new URL(url);
  const [owner, repository, ...rest] = pathname.split('/').filter(Boolean);
  // A page address names the branch after `tree` or `blob`; a raw one right after the repository.
  const folder = rest
    .slice(host === 'raw.githubusercontent.com' ? 1 : 2)
    .filter((part) => !/^SKILL\.md$/i.test(part));

  return [owner, repository, ...folder].filter(Boolean).join('/') || host;
}
