'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { GatewayApi } from '../../../lib/api';
import { GatewayAnswer } from '../../../lib/api/result';
import { subscribe } from '../../../lib/events';
import { keys } from '../../../lib/query/keys';
import { useCrew } from '../../../lib/stores/crew';
import type { OpenFile } from './store';

/** `sessionChanges` lays a changed file's diff into the viewer; without it the file only reads. */
export type FilesApi = Pick<GatewayApi, 'sessionFiles' | 'sessionFile'> &
  Partial<Pick<GatewayApi, 'sessionChanges'>>;

/** How long after a turn ends or a worktree changes the files are read again, in ms. */
const GATHER_MS = 1000;
/**
 * While a turn works, each tool it finishes may have written a file. A listing walks a whole
 * checkout, so those are followed at most this often, in ms.
 */
const STEP_MS = 5000;
const ENDED = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'run.waiting',
  'session.worktree',
]);
/** The longest wait between two tries of a read that keeps failing, in ms. */
const RETRY_CAP_MS = 15_000;

/**
 * The gateway answered and said no: a conversation on a machine, no project, a file that is
 * gone. Asking again at once would get the same answer, so its sentence is shown until the files
 * are read again. Anything else (the gateway away, a failed read) is tried again by itself.
 */
const refused = (error: unknown) =>
  error instanceof GatewayAnswer &&
  error.status !== undefined &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 408 &&
  error.status !== 429;

const again = {
  retry: (_failures: number, error: unknown) => !refused(error),
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, RETRY_CAP_MS),
  refetchOnWindowFocus: true,
} as const;

/** Every file of the conversation's roots, and which changed. */
export function useSessionFiles(api: FilesApi, profileId: string, sessionId: string | undefined) {
  return useQuery({
    queryKey: keys.sessionFiles(profileId, sessionId ?? ''),
    queryFn: () => api.sessionFiles(profileId, sessionId ?? ''),
    enabled: Boolean(sessionId),
    ...again,
  });
}

/** One file as it is on disk now. */
export function useSessionFile(
  api: FilesApi,
  profileId: string,
  sessionId: string,
  file: OpenFile | undefined,
) {
  return useQuery({
    queryKey: keys.sessionFiles(profileId, sessionId, file?.root ?? '', file?.path ?? ''),
    queryFn: () => api.sessionFile(profileId, sessionId, file?.root ?? '', file?.path ?? ''),
    enabled: Boolean(file),
    ...again,
  });
}

/**
 * What the agent does changes the files: the listing and the open file are read again when a
 * turn ends and, less often, as its tools finish, with nothing to press. A read once planned is
 * never put off by the next event, or a long turn would keep the files from ever being read. An
 * event names its conversation only when it can, so one that names none counts. The tree and the
 * viewer may both listen: a read already on its way is left to finish rather than started over.
 */
export function useFilesFollow(profileId: string, sessionId: string | undefined) {
  const client = useQueryClient();

  useEffect(() => {
    if (!sessionId) return;
    let timer: ReturnType<typeof setTimeout>;
    let due = Number.POSITIVE_INFINITY;
    const stop = subscribe((event) => {
      const wait = ENDED.has(event.type)
        ? GATHER_MS
        : event.type === 'run.step'
          ? STEP_MS
          : undefined;
      if (wait === undefined) return;
      const about = (event.data as { sessionId?: string } | undefined)?.sessionId;
      if (about && about !== sessionId) return;
      const at = Date.now() + wait;
      if (at >= due) return;
      clearTimeout(timer);
      due = at;
      timer = setTimeout(() => {
        due = Number.POSITIVE_INFINITY;
        void client.invalidateQueries(
          { queryKey: keys.sessionFiles(profileId, sessionId) },
          { cancelRefetch: false },
        );
      }, wait);
    });

    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [client, profileId, sessionId]);
}

/**
 * Whether Changes can show a root's diff. It reads one checkout: the conversation's first
 * worktree, or its one project. A second worktree or one project of several has files to read
 * and no diff to open. `first` is the id of the listing's first root.
 */
export function useDiffable(first: string | undefined) {
  const project = useCrew((state) => Boolean(state.projectId));
  return (root: string) => root === first && (project || root.startsWith('worktree:'));
}

/**
 * Makes room for the file about to take the chat's place: the Inspector leaves the chat's area
 * if it had taken it, and closes where the screen cannot hold both (a phone, a narrow window).
 */
export function revealViewer(phone: boolean) {
  const crew = useCrew.getState();
  if (phone) return crew.close();
  if (crew.full) crew.toggleFull();
  // Still over the chat once drawn: the window has no room beside it.
  requestAnimationFrame(() => {
    if (document.querySelector('[data-inspector-beside="full"]')) useCrew.getState().close();
  });
}
