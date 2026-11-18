'use client';

import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ArtifactsApi } from '../../components/sessions/artifacts/use-artifacts';
import type { GatewayApi, ProfileArtifact, SessionArtifact } from '../../lib/api';
import { subscribe } from '../../lib/events';
import { keys } from '../../lib/query/keys';

/** What the page asks of the gateway: what one open Artifact does, the list and the removal. */
export type ArtifactsPageApi = ArtifactsApi &
  Pick<GatewayApi, 'profileArtifacts' | 'deleteSessionArtifact'>;

/** What narrows the list: words of the title, and one type, either of them empty for all. */
export type ArtifactsFilter = { q: string; type: '' | SessionArtifact['type'] };

/**
 * Every Artifact of the agent, the one changed last first, read a page at a time as the owner
 * asks for more. It is read again each time the page is come back to, and when the agent makes
 * or updates one in any conversation, which the gateway tells the panel as a request to show it.
 * Narrowing it keeps the last list on screen until the new one lands.
 */
export function useProfileArtifacts(
  api: ArtifactsPageApi,
  profileId: string,
  filter: ArtifactsFilter,
) {
  const client = useQueryClient();

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type !== 'conversation.inspector.focus') return;
        if ((event.data as { kind?: string } | undefined)?.kind !== 'artifact') return;
        void client.invalidateQueries({ queryKey: keys.profileArtifacts(profileId) });
      }),
    [client, profileId],
  );

  return useInfiniteQuery({
    queryKey: keys.profileArtifacts(profileId, filter),
    queryFn: ({ pageParam }) =>
      api.profileArtifacts(profileId, {
        ...(filter.q ? { q: filter.q } : {}),
        ...(filter.type ? { type: filter.type } : {}),
        ...(pageParam ? { before: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    // No stream says a conversation was deleted with what it held, so it is never taken as fresh.
    staleTime: 0,
  });
}

/**
 * Removes one for good, then reads again every list that held it: the page's, and its
 * conversation's, whose Inspector falls back to its list when the one it showed is gone.
 */
export function useDeleteArtifact(api: ArtifactsPageApi, profileId: string) {
  const client = useQueryClient();

  return async (artifact: ProfileArtifact) => {
    await api.deleteSessionArtifact(profileId, artifact.sessionId, artifact.id);
    await Promise.all([
      client.invalidateQueries({ queryKey: keys.profileArtifacts(profileId) }),
      client.invalidateQueries({
        queryKey: keys.sessionArtifacts(profileId, artifact.sessionId),
        exact: true,
      }),
    ]);
  };
}
