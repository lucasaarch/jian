import type { GitHubLinkSummary } from '@/lib/api';
import type { GitHubItem } from '@/lib/stores/crew';

/** A pull request or issue on github.com, with anything after its number: /files, #comment. */
const LINK =
  /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/(pull|issues)\/(\d{1,8})(?:[/?#]\S*)?$/;

/** The GitHub item a link points to, or undefined for any other link. */
export function githubItemOf(url: string): GitHubItem | undefined {
  const match = LINK.exec(url);

  if (!match) return undefined;
  return {
    kind: match[3] === 'pull' ? 'pull' : 'issue',
    owner: match[1] ?? '',
    repo: match[2] ?? '',
    number: Number(match[4]),
    url,
  };
}

/** The gateway takes this many links per request. */
const BATCH = 20;

/**
 * One request for every link the cards of a render ask about, instead of one each: the cards
 * ask in the same tick, and the batch goes out on the next.
 */
export function linkBatcher(resolve: (urls: string[]) => Promise<GitHubLinkSummary[]>) {
  let waiting = new Map<string, Array<(summary: GitHubLinkSummary) => void>>();
  let scheduled = false;

  const flush = () => {
    const batch = waiting;

    waiting = new Map();
    scheduled = false;
    const urls = [...batch.keys()];

    for (let start = 0; start < urls.length; start += BATCH) {
      const chunk = urls.slice(start, start + BATCH);
      // A failed lookup leaves the links plain, as an unreachable one would be.
      const answer = (url: string, summary?: GitHubLinkSummary) => {
        for (const settle of batch.get(url) ?? []) settle(summary ?? { url, reachable: false });
      };

      resolve(chunk)
        .then((summaries) => {
          chunk.forEach((url, index) => {
            answer(url, summaries[index]);
          });
        })
        .catch(() => {
          for (const url of chunk) answer(url);
        });
    }
  };

  return (url: string) =>
    new Promise<GitHubLinkSummary>((settle) => {
      waiting.set(url, [...(waiting.get(url) ?? []), settle]);
      if (!scheduled) {
        scheduled = true;
        setTimeout(flush, 0);
      }
    });
}
