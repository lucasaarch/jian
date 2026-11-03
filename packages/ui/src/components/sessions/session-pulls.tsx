'use client';

import { Popover } from '@base-ui/react/popover';
import { useQuery } from '@tanstack/react-query';
import { GitPullRequest } from 'lucide-react';
import { useRef, useState } from 'react';
import { pillClass, Skeleton, SkeletonLine } from '../../kit';
import type { GatewayApi, GitHubLinkSummary } from '../../lib/api';
import { githubItemOf, linkBatcher } from '../../lib/github-links';
import { keys } from '../../lib/query/keys';
import { useCrew } from '../../lib/stores/crew';
import { type Reachable, shownOf, standingOf, stateMark, useLinkSummary } from './github';

type PullsApi = Pick<GatewayApi, 'sessionPulls' | 'resolveGithubLinks'>;

/** Where one stands, in a line: what is finished says only that, its old checks no longer matter. */
function standing(pull: Reachable): string {
  const said = [standingOf(pull)];

  if (pull.state === 'open') {
    if (pull.mergeable === 'conflicts') said.push('Conflicts');
    if (pull.checks?.failing) said.push('Checks failing');
    else if (pull.checks?.pending) said.push('Checks pending');
    else if (pull.checks?.passing) said.push('Checks passing');
  }

  return said.join(' · ');
}

type Watch = { status: 'watching' | 'ended' | 'unreachable'; reason?: string };

/**
 * Whether the gateway watches it for the agent, after where it stands: said only while it does,
 * or when it cannot, with why. One merged or closed says so already.
 */
function WatchNote({ watch }: { watch: Watch | undefined }) {
  if (watch?.status === 'watching') return <> · Watching</>;
  if (watch?.status !== 'unreachable') return null;
  return (
    <>
      {' · '}
      <span title={watch.reason}>Not watched</span>
      {watch.reason && <span className="sr-only">: {watch.reason}</span>}
    </>
  );
}

function PullRow({
  url,
  watch,
  load,
  onOpen,
}: {
  url: string;
  watch: Watch | undefined;
  load: (url: string) => Promise<GitHubLinkSummary>;
  onOpen: () => void;
}) {
  const { data } = useLinkSummary(url, load);
  const item = githubItemOf(url);

  if (!data) {
    return (
      <div className="session-pull" aria-hidden="true">
        <Skeleton className="mt-0.5 size-3.5 shrink-0" />
        <div className="grid min-w-0 flex-1">
          <SkeletonLine className="w-3/5" />
          <SkeletonLine className="w-1/3" />
        </div>
      </div>
    );
  }

  // One the App cannot see is still one the agent created: it stays counted, with the way to it.
  if (!data.reachable) {
    return (
      <a className="session-pull" href={url} target="_blank" rel="noreferrer">
        <GitPullRequest
          size={14}
          aria-hidden="true"
          className="session-pull-mark"
          data-state="draft"
        />
        <span className="session-pull-text">
          <span className="session-pull-title">{item ? `${item.owner}/${item.repo}` : url}</span>
          <span className="session-pull-meta">
            Status unavailable
            <WatchNote watch={watch} />
          </span>
        </span>
        {item && <span className="session-pull-number">#{item.number}</span>}
      </a>
    );
  }

  const Mark = stateMark(data);

  return (
    <button type="button" className="session-pull" onClick={onOpen}>
      <Mark size={14} aria-hidden="true" className="session-pull-mark" data-state={shownOf(data)} />
      <span className="session-pull-text">
        <span className="session-pull-title" title={data.title}>
          {data.title}
        </span>
        <span className="session-pull-meta">
          {data.repo} · {standing(data)}
          <WatchNote watch={watch} />
        </span>
      </span>
      <span className="session-pull-number">#{data.number}</span>
    </button>
  );
}

/**
 * The pull requests the agent created in this conversation, as a badge beside its objective, with
 * how each stands in the list it opens. The count comes from the gateway, which reads the whole
 * conversation, and asks GitHub nothing: only opening the list does. A gateway too old to answer
 * leaves simply no badge.
 */
export function SessionPulls({
  api,
  profileId,
  sessionId,
}: {
  api: PullsApi;
  profileId: string;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [load] = useState(() => linkBatcher((urls) => api.resolveGithubLinks(urls)));
  const { data: pulls = [] } = useQuery({
    queryKey: keys.sessionPulls(profileId, sessionId),
    queryFn: () => api.sessionPulls(profileId, sessionId),
  });

  if (!pulls.length) return null;

  const label = pulls.length === 1 ? '1 PR' : `${pulls.length} PRs`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        ref={trigger}
        className={`${pillClass()} session-badge-trigger`}
        aria-label={`${label}: show the pull requests the agent created`}
      >
        <GitPullRequest size={12} aria-hidden="true" />
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="select-positioner"
          side="top"
          align="end"
          sideOffset={8}
          positionMethod="fixed"
          collisionBoundary={[]}
        >
          <Popover.Popup className="model-menu session-badge-popup session-pulls-popup">
            <Popover.Title className="session-badge-title">Pull requests</Popover.Title>
            <ul className="session-pulls" aria-label="Pull requests">
              {pulls.map(({ url, watch }) => (
                <li key={url}>
                  <PullRow
                    url={url}
                    watch={watch}
                    load={load}
                    onOpen={() => {
                      const item = githubItemOf(url);
                      setOpen(false);
                      if (item) useCrew.getState().open(item, trigger.current);
                    }}
                  />
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
