'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Action } from '../../../kit';
import type { GatewayApi, GitHubLinkSummary } from '../../../lib/api';
import { keys } from '../../../lib/query/keys';
import { useCrew } from '../../../lib/stores/crew';
import { GitHubLogo } from '../../ui';
import { useDrawerFocus } from '../crew';
import { type FoldAll, FoldAllContext } from '../fold-all';
import { InspectorBar } from '../inspector';
import { IssueView } from './issue-view';
import { DrawerOptions } from './options';
import { DrawerSkeleton } from './parts';
import { type Pull, PullView } from './pull-view';

type DrawerApi = Pick<GatewayApi, 'githubPull' | 'githubIssue' | 'mergeGithubPull'>;

/** How often an open pull request is read again while it is followed, in ms. */
const OPEN_PULL_MS = 15_000;
/** Sooner while GitHub is still working out whether it can merge. */
const MERGEABLE_RETRY_MS = 3_000;

/**
 * A pull request or an issue followed beside the conversation, in the Inspector. It runs from the
 * top of the window: its first line says where the item lives and opens it on GitHub, with its
 * options and its close at the end. It reads itself again while it can change; its close, Escape
 * or the reference that opened it puts it away. Any conversation can have its agent
 * settle a pull request's conflicts; only one the panel answers itself merges from here, as a
 * chat on WhatsApp or Telegram decides its approvals there.
 */
export function GitHubDrawer({
  api,
  profileId,
  merges = false,
  fixConflicts,
}: {
  api: DrawerApi;
  profileId: string;
  merges?: boolean;
  fixConflicts?: (pull: Pull) => Promise<unknown>;
}) {
  const client = useQueryClient();
  const item = useCrew((state) => state.item);
  const following = useCrew((state) => state.following);
  const closer = useRef<HTMLButtonElement>(null);
  // How its diffs read and whether its parts were last folded together: for this drawer only.
  const [wrap, setWrap] = useState(false);
  const [fold, setFold] = useState<FoldAll | null>(null);
  const issue = useQuery({
    queryKey: item ? keys.githubItem('issue', item.owner, item.repo, item.number) : ['none'],
    queryFn: () => api.githubIssue(item?.owner ?? '', item?.repo ?? '', item?.number ?? 0),
    enabled: item?.kind === 'issue',
  });
  // A link to an issue number GitHub answers as a pull request shows the pull request.
  const isPull = item?.kind === 'pull' || issue.data?.kind === 'pull';
  const pull = useQuery({
    queryKey: item ? keys.githubItem('pull', item.owner, item.repo, item.number) : ['none'],
    queryFn: () => api.githubPull(item?.owner ?? '', item?.repo ?? '', item?.number ?? 0),
    enabled: Boolean(item) && isPull,
    refetchInterval: (query) =>
      query.state.data?.state !== 'open'
        ? false
        : query.state.data.mergeable === 'unknown'
          ? MERGEABLE_RETRY_MS
          : OPEN_PULL_MS,
  });

  // What the drawer reads is the newest word on the pull request: every reference to it in the
  // conversation shows the same, the moment it arrives.
  useEffect(() => {
    const read = pull.data;
    if (!read) return;
    client.setQueriesData<GitHubLinkSummary>(
      { queryKey: ['integrations', 'github', 'links'] },
      (known) =>
        known?.reachable &&
        known.owner.toLowerCase() === read.owner.toLowerCase() &&
        known.repo.toLowerCase() === read.repo.toLowerCase() &&
        known.number === read.number
          ? {
              ...known,
              title: read.title,
              state: read.state,
              draft: read.draft,
              checks: read.checks.summary,
              mergeable: read.mergeable,
            }
          : known,
    );
  }, [client, pull.data]);

  useDrawerFocus(item ? following : undefined, closer);

  if (!item) return null;
  const current = isPull ? pull : issue;
  const where = `${item.owner}/${item.repo} #${item.number}`;
  const url = `https://github.com/${item.owner}/${item.repo}/${isPull ? 'pull' : 'issues'}/${item.number}`;

  return (
    <aside aria-label={where} data-wrap={wrap || undefined} className="crew-drawer">
      <InspectorBar
        closer={closer}
        options={
          <DrawerOptions
            url={url}
            diffs={isPull}
            wrap={wrap}
            setWrap={setWrap}
            folded={fold?.open === false}
            fold={(open) => setFold({ open, round: (fold?.round ?? 0) + 1 })}
            refresh={() => void current.refetch()}
          />
        }
      >
        <GitHubLogo size={14} />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          title="Open on GitHub"
          className="flex min-w-0 items-center gap-1.5 font-mono text-xs transition-colors hover:text-ink"
        >
          <span className="truncate">{where}</span>
          <ExternalLink size={12} aria-hidden="true" className="shrink-0" />
        </a>
      </InspectorBar>
      {/* The item's heading stays put; only its parts under it scroll. */}
      <FoldAllContext.Provider value={fold}>
        <div className="flex min-h-0 flex-1 flex-col">
          {isPull && pull.data ? (
            <PullView
              api={api}
              pull={pull.data}
              profileId={profileId}
              merges={merges}
              fixConflicts={fixConflicts}
            />
          ) : !isPull && issue.data ? (
            <IssueView issue={issue.data} />
          ) : current.error ? (
            <div className="grid justify-items-start gap-3 px-5 pt-2">
              <p className="text-[13px] text-bad">
                {current.error instanceof Error ? current.error.message : 'GitHub did not answer.'}
              </p>
              <Action tone="outline" size="small" onClick={() => void current.refetch()}>
                Try again
              </Action>
            </div>
          ) : current.fetchStatus === 'paused' ? (
            // Reads wait while the gateway is away rather than fail; said, so it does not look stuck.
            <p className="px-5 pt-2 text-[13px] text-muted">
              Waiting for the gateway to answer. It opens as soon as it does.
            </p>
          ) : (
            <DrawerSkeleton />
          )}
        </div>
      </FoldAllContext.Provider>
    </aside>
  );
}
