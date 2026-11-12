'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GitHubPullFilter, GitHubPullRow, GitHubReviewSettings } from '../../lib/api';
import { panelApi } from '../../lib/query/client';
import { keys } from '../../lib/query/keys';
import { notifyError } from '../../lib/workspace';

/**
 * The pull requests on screen. A minute old is fresh enough for a list the owner refreshes by
 * hand; anything newer is one press of the refresh button away.
 */
export function usePulls(filter: GitHubPullFilter, repository: string, q: string) {
  return useQuery({
    queryKey: keys.githubPulls(filter, repository, q),
    queryFn: () =>
      panelApi().githubPulls({
        filter,
        ...(repository ? { repository } : {}),
        ...(q ? { q } : {}),
      }),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });
}

export function useReviewSettings() {
  return useQuery({ queryKey: keys.githubReviews, queryFn: () => panelApi().githubReviews() });
}

/** Reads again every list of pull requests, so a review just started shows on its row. */
const refreshPulls = (client: ReturnType<typeof useQueryClient>) =>
  client.invalidateQueries({ queryKey: ['integrations', 'github', 'pulls'] });

export function useStartReview() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ pull, profileId }: { pull: GitHubPullRow; profileId: string }) =>
      panelApi().startGithubPullReview(pull.owner, pull.repo, pull.number, profileId),
    onSuccess: () => refreshPulls(client),
    onError: (error) => notifyError(error, 'The review could not start.'),
  });
}

export function useSaveReviewSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (settings: GitHubReviewSettings) => panelApi().saveGithubReviews(settings),
    onSuccess: (status) => client.setQueryData(keys.githubReviews, status),
    onError: (error) => notifyError(error, 'The review settings could not be saved.'),
  });
}

export function useSetUpWebhook() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => panelApi().setUpGithubWebhook(),
    onSuccess: (status) => client.setQueryData(keys.githubReviews, status),
    onError: (error) => notifyError(error, 'GitHub did not take the webhook.'),
  });
}
