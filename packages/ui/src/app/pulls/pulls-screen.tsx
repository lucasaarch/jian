'use client';

import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Settings2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import {
  Action,
  FilterSelect,
  HoverTip,
  iconButton,
  SearchField,
  Segmented,
  SkeletonLine,
} from '../../kit';
import type { GitHubPullFilter, GitHubPullRow } from '../../lib/api';
import { agentPath } from '../../lib/navigation';
import { queries } from '../../lib/query/profile';
import { useNoInspector } from '../../lib/stores/screen';
import { useRouter } from '../../platform/navigation';
import { ScreenHeader } from '../screen-header';
import { pullKey } from './cells';
import { PullTable } from './pull-table';
import { ReviewSettings } from './review-settings';
import { usePulls, useReviewSettings, useStartReview } from './use-pulls';

/** How long typing rests before the search goes to GitHub, in milliseconds. */
const SEARCH_PAUSE = 400;

/**
 * The open pull requests of every account the GitHub App is installed on, in place of the chat.
 * Each can be handed to an agent to review; the settings say who and how, and whether new ones
 * are reviewed on their own.
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
    <section aria-label="Pull requests" className="flex h-full flex-col overflow-hidden">
      <ScreenHeader title="Pull requests">
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
      </ScreenHeader>

      {/* The filters scroll with the list, sticking to its top, so both are as wide as what
          the scrollbar leaves and their right edges meet. A rule parts them from the list, which
          lies on the page itself, edge to edge, as a pull request's Changes lies in the
          Inspector: no card, only the lines between its rows. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-canvas px-5 py-3 phone:px-3">
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
          <SearchField
            label="Search pull requests"
            value={typed}
            onValueChange={setTyped}
            className="min-w-48 flex-1"
          />
        </div>

        <div className="pb-6">
          {list?.unreachable.length ? (
            <p className="border-b border-line px-5 py-2.5 text-xs text-warn phone:px-3">
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
            <div className="grid gap-4 px-5 pt-4 phone:px-3" aria-busy="true">
              {[0, 1, 2, 3, 4].map((row) => (
                <SkeletonLine key={row} />
              ))}
            </div>
          ) : list.pulls.length ? (
            <div className="@container">
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
            <p className="mt-3 px-5 text-xs text-muted phone:px-3">
              Only the most recently updated are shown. Search or pick a repository to find others.
            </p>
          )}
        </div>
      </div>

      <ReviewSettings open={settingsOpen} onOpenChange={setSettingsOpen} status={reviews.data} />
    </section>
  );
}

function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-3 py-16 text-center text-sm text-muted">
      <p>{text}</p>
      {action}
    </div>
  );
}
