'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { GatewayApi } from '../../../lib/api';
import { subscribe } from '../../../lib/events';
import { keys } from '../../../lib/query/keys';

export type ArtifactsApi = Pick<
  GatewayApi,
  | 'sessionArtifacts'
  | 'sessionArtifactVersion'
  | 'exportSessionArtifact'
  | 'setSessionArtifactVisibility'
  | 'editSessionArtifact'
  // A file's bytes, which are media of the conversation.
  | 'media'
>;

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
