'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { keys } from '../../../lib/query/keys';
import { type ArtifactDraft, useArtifactDraft } from '../../../lib/stores/artifact-draft';
import type { ArtifactsApi } from './use-artifacts';

/** How long a draft whose version never comes (the tool failed) is kept before it is let go. */
const LET_GO = 4000;

/**
 * Lets the writing go once the version it became can be drawn. When the call ends, the last of
 * the draft stays on screen while the list is read again and the new version's source is
 * fetched, and only then does the drawn one take its place: the owner sees no empty frame in
 * between. A call that made nothing is let go after a few seconds.
 */
export function useDraftHandoff(
  api: ArtifactsApi,
  profileId: string,
  sessionId: string | undefined,
  draft: ArtifactDraft | undefined,
) {
  const client = useQueryClient();
  const done = draft?.done === true;
  const artifactId = draft?.artifactId;

  useEffect(() => {
    if (!sessionId || !done) return;
    let waiting = true;
    const release = () => {
      if (waiting) useArtifactDraft.getState().forget(sessionId);
    };
    const fallback = setTimeout(release, LET_GO);

    void (async () => {
      const list = await client.fetchQuery({
        queryKey: keys.sessionArtifacts(profileId, sessionId),
        queryFn: () => api.sessionArtifacts(profileId, sessionId),
        staleTime: 0,
      });
      // The list is the one changed last first: a call that made one made the first of it.
      const made = artifactId ? list.find((item) => item.id === artifactId) : list[0];
      if (!made) return;
      await client.fetchQuery({
        queryKey: keys.sessionArtifacts(profileId, sessionId, made.id, made.version),
        queryFn: () => api.sessionArtifactVersion(profileId, sessionId, made.id, made.version),
        staleTime: Number.POSITIVE_INFINITY,
      });
      release();
    })().catch(() => undefined);

    return () => {
      waiting = false;
      clearTimeout(fallback);
    };
  }, [client, api, profileId, sessionId, done, artifactId]);
}
