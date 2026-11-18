'use client';

import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Settings2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import {
  Action,
  FilterSelect,
  HoverTip,
  iconButton,
  PageBody,
  PageHeading,
  PageToolbar,
  SearchField,
  Segmented,
  SkeletonLine,
  SkeletonRegion,
  surfaceCard,
} from '../../kit';
import type { GitHubPullFilter, GitHubPullRow } from '../../lib/api';
import { agentPath } from '../../lib/navigation';
import { queries } from '../../lib/query/profile';
import { useNoInspector } from '../../lib/stores/screen';
import { useRouter } from '../../platform/navigation';
import { pullKey } from './cells';
import { PullTable } from './pull-table';
import { ReviewSettings } from './review-settings';
import { usePulls, useReviewSettings, useStartReview } from './use-pulls';

/** How long typing rests before the search goes to GitHub, in milliseconds. */
const SEARCH_PAUSE = 400;

/**
 * The open pull requests of every account the GitHub App is installed on, in place of the chat,
 * a page of the kit's one anatomy as every other screen is: the filters in its toolbar, the
 * table in a card. Each can be handed to an agent to review; the settings say who and how, and
 * whether new ones are reviewed on their own.
 */
export function PullsScreen({ profileId }: { profileId: string }) {
  const router = useRouter();
  // A list of every pull request has no conversation for an Inspector to go with.
  useNoInspector();
  const accounts = useQuery(queries.githubIntegration()).data?.accounts ?? [];
  const repositories = useQuery(queries.githubRepositories()).data ?? [];
  const [filter, setFilter] = useState<GitHubPullFilter>('open');
  const [repository, setRepository] = useState('');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), SEARCH_PAUSE);
    return () => clearTimeout(timer);
  }, [typed]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pulls = usePulls(filter, repository, q);
  const reviews = useReviewSettings();
  const start = useStartReview();
  const reviewer = reviews.data?.settings.profileId ?? profileId;

  const review = (pull: GitHubPullRow) => start.mutate({ pull, profileId: reviewer });
  const openChat = (done: NonNullable<GitHubPullRow['review']>) =>
    router.push(agentPath(done.profileId, `sessions/${encodeURIComponent(done.sessionId)}`));
  // Only an account the App is installed on as a person has pull requests of its own.
  const person = accounts.some((account) => account.type === 'User');
  const filters = [
    { value: 'open' as const, label: 'Open' },
    ...(person ? [{ value: 'mine' as const, label: 'Mine' }] : []),
    { value: 'review' as const, label: 'Needs review' },
  ];
  const list = pulls.data;

  return (
    <div className="flex h-full min-h-0">
      <PageBody labelledBy="pulls-title">
        <PageHeading
          id="pulls-title"
          title="Pull requests"
          description="Open pull requests of the connected GitHub accounts, each ready for an agent to review."
          actions={
            <>
              <HoverTip tip="Refresh" side="bottom">
                <button
                  type="button"
                  aria-label="Refresh pull requests"
                  className={iconButton}
                  onClick={() => void pulls.refetch()}
                >
                  <RefreshCw
                    size={15}
                    className={pulls.isFetching ? 'animate-spin' : ''}
                    aria-hidden="true"
                  />
                </button>
              </HoverTip>
              <HoverTip tip="Review settings" side="bottom" align="end">
                <button
                  type="button"
                  aria-label="Review settings"
                  className={iconButton}
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings2 size={15} aria-hidden="true" />
                </button>
              </HoverTip>
            </>
          }
        />
        <PageToolbar>
          <SearchField
            label="Search pull requests"
            value={typed}
            onValueChange={setTyped}
            className="min-w-44 flex-1"
          />
          <Segmented
            label="Pull requests to show"
            value={filter}
            options={filters}
            onChange={setFilter}
          />
          <FilterSelect
            label="Repository"
            value={repository}
            options={[
              { value: '', label: 'All repositories' },
              ...repositories.map((repo) => ({ value: repo.fullName, label: repo.fullName })),
            ]}
            onValueChange={setRepository}
          />
        </PageToolbar>

        {list?.unreachable.length ? (
          <p className="text-xs text-warn">
            GitHub did not answer for {list.unreachable.join(', ')}. Their pull requests are left
            out.
          </p>
        ) : null}
        {pulls.isError && !list ? (
          <Empty
            text="The pull requests could not be read from GitHub."
            action={<Action onClick={() => void pulls.refetch()}>Try again</Action>}
          />
        ) : !list ? (
          <SkeletonRegion
            label="Loading pull requests…"
            className={`grid gap-4 p-4 ${surfaceCard}`}
          >
            {[0, 1, 2, 3, 4].map((row) => (
              <SkeletonLine key={row} />
            ))}
          </SkeletonRegion>
        ) : list.pulls.length ? (
          // The table goes by the card's width, not the window's: it is the container.
          <div className={`@container overflow-hidden ${surfaceCard}`}>
            <PullTable
              pulls={list.pulls}
              starting={
                start.isPending && start.variables ? pullKey(start.variables.pull) : undefined
              }
              review={review}
              openChat={openChat}
            />
          </div>
        ) : (
          <Empty text={q || repository ? 'No pull request matches.' : 'No open pull requests.'} />
        )}
        {list?.truncated && (
          <p className="text-xs text-muted">
            Only the most recently updated are shown. Search or pick a repository to find others.
          </p>
        )}
      </PageBody>

      <ReviewSettings open={settingsOpen} onOpenChange={setSettingsOpen} status={reviews.data} />
    </div>
  );
}

function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div
      className={`grid justify-items-start gap-3 px-4 py-3 text-[13px] text-muted ${surfaceCard}`}
    >
      <p>{text}</p>
      {action}
    </div>
  );
}
