'use client';

import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ArtifactsApi } from '../../components/sessions/artifacts/use-artifacts';
import type { GatewayApi, ProfileArtifact, SessionArtifact } from '../../lib/api';
import { subscribe } from '../../lib/events';
import { keys } from '../../lib/query/keys';

/** What the page asks of the gateway: what one open Artifact does, the lists, and their keeping. */
export type ArtifactsPageApi = ArtifactsApi &
  Pick<
    GatewayApi,
    | 'profileArtifacts'
    | 'deleteSessionArtifact'
    | 'updateSessionArtifact'
    | 'duplicateSessionArtifact'
    | 'artifactFolders'
    | 'createArtifactFolder'
    | 'renameArtifactFolder'
    | 'deleteArtifactFolder'
  >;

/** What narrows the page: words of the title, and one type, either of them empty for all. */
export type ArtifactsFilter = { q: string; type: '' | SessionArtifact['type'] };

/**
 * One reading of the page: what narrows it, the folder it is in (one of the owner's, or what a
 * project still holds), and which half of it, the pinned ones or the rest.
 */
export type ArtifactsReading = ArtifactsFilter & {
  folder?: string;
  project?: string;
  pinned: 'true' | 'false';
};

/**
 * The most the gateway answers at once, which the pinned ones are asked for in one go: they are
 * shown whole, with no "Load more" of their own.
 */
const PINNED_AT_ONCE = 100;

/**
 * The Artifacts of one reading, the one changed last first, a page at a time as the owner asks
 * for more. Read again each time the page is come back to. Narrowing it keeps the last list on
 * screen until the new one lands.
 */
export function useProfileArtifacts(
  api: ArtifactsPageApi,
  profileId: string,
  reading: ArtifactsReading,
) {
  return useInfiniteQuery({
    queryKey: keys.profileArtifacts(profileId, reading),
    queryFn: ({ pageParam }) =>
      api.profileArtifacts(profileId, {
        ...(reading.q ? { q: reading.q } : {}),
        ...(reading.type ? { type: reading.type } : {}),
        ...(reading.folder ? { folder: reading.folder } : {}),
        ...(reading.project ? { project: reading.project } : {}),
        pinned: reading.pinned,
        ...(reading.pinned === 'true' ? { limit: PINNED_AT_ONCE } : {}),
        ...(pageParam ? { before: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    // No stream says a conversation was deleted with what it held, so it is never taken as fresh.
    staleTime: 0,
  });
}

/** The owner's folders, and the projects that hold what nobody moved, with how many each has. */
export function useArtifactFolders(api: ArtifactsPageApi, profileId: string) {
  return useQuery({
    queryKey: keys.artifactFolders(profileId),
    queryFn: () => api.artifactFolders(profileId),
    staleTime: 0,
  });
}

/**
 * Everything the page shows is read again when the agent makes or updates an Artifact in any
 * conversation, which the gateway tells the panel as a request to show it.
 */
export function useArtifactsPageFollow(profileId: string) {
  const client = useQueryClient();

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type !== 'conversation.inspector.focus') return;
        if ((event.data as { kind?: string } | undefined)?.kind !== 'artifact') return;
        void client.invalidateQueries({ queryKey: keys.profileArtifacts(profileId) });
        void client.invalidateQueries({ queryKey: keys.artifactFolders(profileId) });
      }),
    [client, profileId],
  );
}

/**
 * What the owner does to keep the page: each asks the gateway, then reads again every list the
 * change shows in. That is every reading of the page and its folders, whose counts move with
 * it, and the conversation's own list, which the Inspector draws. Each throws what the gateway
 * refused with, as when a paired phone asks.
 */
export function useArtifactKeeping(api: ArtifactsPageApi, profileId: string) {
  const client = useQueryClient();
  const again = (sessionId?: string) =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.profileArtifacts(profileId) }),
      client.invalidateQueries({ queryKey: keys.artifactFolders(profileId) }),
      ...(sessionId
        ? [
            client.invalidateQueries({
              queryKey: keys.sessionArtifacts(profileId, sessionId),
              exact: true,
            }),
          ]
        : []),
    ]);

  return {
    /** Its name, its pin, or its folder (`null` for where it started); no version is made. */
    change: async (
      artifact: ProfileArtifact,
      to: { title?: string; pinned?: boolean; folderId?: string | null },
    ) => {
      await api.updateSessionArtifact(profileId, artifact.sessionId, artifact.id, to);
      await again(artifact.sessionId);
    },
    duplicate: async (artifact: ProfileArtifact) => {
      await api.duplicateSessionArtifact(profileId, artifact.sessionId, artifact.id);
      await again(artifact.sessionId);
    },
    /** For good, with every version it had. */
    remove: async (artifact: ProfileArtifact) => {
      await api.deleteSessionArtifact(profileId, artifact.sessionId, artifact.id);
      await again(artifact.sessionId);
    },
    createFolder: async (name: string) => {
      const folder = await api.createArtifactFolder(profileId, name);
      await again();
      return folder;
    },
    renameFolder: async (folderId: string, name: string) => {
      await api.renameArtifactFolder(profileId, folderId, name);
      await again();
    },
    /** The folder alone: what it held goes back where it started. */
    deleteFolder: async (folderId: string) => {
      await api.deleteArtifactFolder(profileId, folderId);
      await again();
    },
  };
}

export type ArtifactKeeping = ReturnType<typeof useArtifactKeeping>;
