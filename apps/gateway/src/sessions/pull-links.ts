/** How many pull requests one read names: more than a conversation has reason to open. */
const MOST = 200;

/**
 * On github.com only, with anything after the number left off, or GitHub's API address of the
 * same pull request, which an answer cut short may name alone. A longer number is no match.
 */
const PULL =
  /https?:\/\/(?:(?:www\.)?github\.com\/([\w-]{1,39})\/([\w.-]{1,100})\/pull\/(\d{1,8})|api\.github\.com\/repos\/([\w-]{1,39})\/([\w.-]{1,100})\/pulls\/(\d{1,8}))(?!\d)/gi;

/**
 * The pull requests a list of texts name, each once and in one form, in the order given: the
 * same one reached by `/files`, a comment's anchor or the API is still one pull request. GitHub
 * reads owners and repositories in any case, so the same one written differently is one too.
 */
export function pullLinksIn(texts: string[]): { url: string }[] {
  const found = new Map<string, { url: string }>();

  for (const text of texts) {
    for (const match of text.matchAll(PULL)) {
      const [owner, repo, number] = match[1] ? match.slice(1, 4) : match.slice(4, 7);
      const url = `https://github.com/${owner}/${repo}/pull/${number}`;
      const key = url.toLowerCase();
      if (!found.has(key)) found.set(key, { url });
      if (found.size === MOST) return [...found.values()];
    }
  }

  return [...found.values()];
}
