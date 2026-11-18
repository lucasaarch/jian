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
