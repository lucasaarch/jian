/** How many pull requests one read names: more than a conversation has reason to link. */
const MOST = 200;

/** On github.com only, with anything after the number left off. A longer number is no match. */
const PULL =
  /https?:\/\/(?:www\.)?github\.com\/([\w-]{1,39})\/([\w.-]{1,100})\/pull\/(\d{1,8})(?!\d)/gi;

/**
 * The pull requests a list of texts link to, each once and in one form, in the order given: the
 * same one reached by `/files` or a comment's anchor is still one pull request. GitHub reads
 * owners and repositories in any case, so the same one written differently is one too.
 */
export function pullLinksIn(texts: string[]): { url: string }[] {
  const found = new Map<string, { url: string }>();

  for (const text of texts) {
    for (const [, owner, repo, number] of text.matchAll(PULL)) {
      const url = `https://github.com/${owner}/${repo}/pull/${number}`;
      const key = url.toLowerCase();
      if (!found.has(key)) found.set(key, { url });
      if (found.size === MOST) return [...found.values()];
    }
  }

  return [...found.values()];
}
