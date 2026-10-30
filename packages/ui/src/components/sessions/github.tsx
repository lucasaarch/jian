'use client';

import { useQuery } from '@tanstack/react-query';
import {
  CircleCheck,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from 'lucide-react';
import { type ReactNode, useCallback, useState } from 'react';
import type { GatewayApi, GitHubLinkSummary } from '../../lib/api';
import { githubItemOf, linkBatcher } from '../../lib/github-links';
import { keys } from '../../lib/query/keys';
import { type GitHubItem, itemKey, useCrew } from '../../lib/stores/crew';
import { MarkdownLinks } from '../ui/markdown';

export { GitHubDrawer } from './github-drawer/drawer';

type LinksApi = Pick<GatewayApi, 'resolveGithubLinks'>;
type Reachable = Extract<GitHubLinkSummary, { reachable: true }>;
type State = Reachable['state'];

/**
 * How long a card's summary is trusted, and how often an open one asks again: a pull request
 * merged or closed elsewhere shows as such within about this long. The gateway keeps a summary
 * as long, so asking sooner would only read its copy.
 */
const CARD_STALE_MS = 30_000;

const stateNames = { open: 'Open', closed: 'Closed', merged: 'Merged' } as const;

type Shown = State | 'draft';

/** GitHub's own marks for where an item stands, so a reference reads at a glance. */
const pullMarks: Record<Shown, LucideIcon> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};
const issueMarks: Record<Shown, LucideIcon> = {
  open: CircleDot,
  draft: CircleDot,
  merged: CircleCheck,
  closed: CircleCheck,
};

/**
 * A link to a pull request or an issue, as a reference: its mark, coloured by where it stands,
 * and its number. The rest is a hover away; clicking follows it in the drawer.
 */
function GitHubCard({ summary, href }: { summary: Reachable; href: string }) {
  const open = useCrew((state) => state.open);
  const close = useCrew((state) => state.close);
  const following = useCrew((state) => state.following);
  const item: GitHubItem = { ...summary, url: href };
  const followed = following === itemKey(item);
  const shown: Shown = summary.draft && summary.state === 'open' ? 'draft' : summary.state;
  const Mark = (summary.kind === 'pull' ? pullMarks : issueMarks)[shown];
  const standing = shown === 'draft' ? 'Draft' : stateNames[summary.state];
  const where = `${summary.owner}/${summary.repo} #${summary.number}`;

  return (
    <button
      type="button"
      className="github-ref"
      data-kind={summary.kind}
      data-state={shown}
      aria-pressed={followed}
      aria-label={`${summary.kind === 'pull' ? 'Pull request' : 'Issue'} ${where}: ${summary.title}, ${standing}`}
      title={`${where} · ${summary.title} · ${standing}`}
      onClick={(event) => (followed ? close() : open(item, event.currentTarget))}
    >
      <Mark size={14} aria-hidden="true" />#{summary.number}
    </button>
  );
}

function GitHubLink({
  href,
  label,
  load,
}: {
  href: string;
  label: string;
  load: (url: string) => Promise<GitHubLinkSummary>;
}) {
  const { data } = useQuery({
    queryKey: keys.githubLink(href),
    queryFn: () => load(href),
    staleTime: CARD_STALE_MS,
    // Only what can still change is asked again: a merged or closed one stays as it is.
    refetchInterval: (query) => {
      const summary = query.state.data;
      return summary?.reachable && summary.state === 'open' ? CARD_STALE_MS : false;
    },
  });

  if (data?.reachable) return <GitHubCard summary={data} href={href} />;
  // Until it is known, and for good when the App cannot see it, the link stays a link.
  return (
    <a className="text-link" href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

/**
 * Links to pull requests and issues inside `children` become cards. Every card on screen is
 * looked up in one request; one the App cannot see stays the plain link it was.
 */
export function GitHubLinks({ api, children }: { api: LinksApi; children: ReactNode }) {
  const [load] = useState(() => linkBatcher((urls) => api.resolveGithubLinks(urls)));
  const render = useCallback(
    (href: string, label: string) =>
      githubItemOf(href) ? <GitHubLink href={href} label={label} load={load} /> : undefined,
    [load],
  );

  return <MarkdownLinks.Provider value={render}>{children}</MarkdownLinks.Provider>;
}
