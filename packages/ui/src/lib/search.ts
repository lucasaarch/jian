/** Case and accents are not what anyone searches by. */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();

/**
 * Every word typed must appear somewhere in the text, so a thing can be found by what it says as
 * well as by what it is called. An empty query matches everything.
 */
export function matchesQuery(text: string, query: string) {
  const haystack = fold(text);

  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}
