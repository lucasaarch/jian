'use client';

import {
  type InfiniteData,
  type QueryClient,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import type { GatewayApi, ProfileArtifact, SessionArtifact } from '../../../lib/api';
import { subscribe } from '../../../lib/events';
import { keys } from '../../../lib/query/keys';

export type ArtifactsApi = Pick<
  GatewayApi,
  | 'sessionArtifacts'
  | 'sessionArtifactVersion'
  | 'exportSessionArtifact'
  | 'setSessionArtifactVisibility'
  | 'editSessionArtifact'
>;

/** One page of the agent's page of every Artifact, as the gateway answers it. */
export type ArtifactsPage = { items: ProfileArtifact[]; nextCursor: string | null };

/**
 * An Artifact as it now stands, after the owner saved an edit or changed who reads it, put
 * where each list holds it: its conversation's, and every reading of the agent's page of them
 * (app/artifacts), which keeps what it knows of the conversation.
 */
export function artifactChanged(client: QueryClient, profileId: string, next: SessionArtifact) {
  client.setQueryData<SessionArtifact[]>(keys.sessionArtifacts(profileId, next.sessionId), (all) =>
    all?.map((item) => (item.id === next.id ? next : item)),
  );
  client.setQueriesData<InfiniteData<ArtifactsPage>>(
    { queryKey: keys.profileArtifacts(profileId) },
    (all) =>
      all && {
        ...all,
        pages: all.pages.map((page) => ({
          ...page,
          items: page.items.map((item) => (item.id === next.id ? { ...item, ...next } : item)),
        })),
      },
  );
}

/** Every Artifact of the conversation, the one changed last first. */
export function useSessionArtifacts(
  api: ArtifactsApi,
  profileId: string,
  sessionId: string | undefined,
) {
  return useQuery({
    queryKey: keys.sessionArtifacts(profileId, sessionId ?? ''),
    queryFn: () => api.sessionArtifacts(profileId, sessionId ?? ''),
    enabled: Boolean(sessionId),
    refetchOnWindowFocus: true,
  });
}

/** One version's source. A version never changes once made, so it is read once. */
export function useArtifactVersion(
  api: ArtifactsApi,
  profileId: string,
  sessionId: string,
  artifactId: string,
  version: number,
) {
  return useQuery({
    queryKey: keys.sessionArtifacts(profileId, sessionId, artifactId, version),
    queryFn: () => api.sessionArtifactVersion(profileId, sessionId, artifactId, version),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * The agent making or updating one is told to the panel as a request to show it (the same event
 * `open_in_inspector` sends), and the list is read again then. It listens whether or not the tab
 * is open: the event that opens the tab is the one that says the list is out of date.
 */
export function useArtifactsFollow(profileId: string, sessionId: string | undefined) {
  const client = useQueryClient();

  useEffect(() => {
    if (!sessionId) return;

    return subscribe((event) => {
      if (event.type !== 'conversation.inspector.focus') return;
      const about = event.data as { sessionId?: string; kind?: string } | undefined;
      if (about?.kind !== 'artifact' || about.sessionId !== sessionId) return;
      // The list alone: the versions under its key never change.
      void client.invalidateQueries({
        queryKey: keys.sessionArtifacts(profileId, sessionId),
        exact: true,
      });
    });
  }, [client, profileId, sessionId]);
}
