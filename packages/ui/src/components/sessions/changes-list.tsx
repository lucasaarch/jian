'use client';

import { useQueries } from '@tanstack/react-query';
import type { GatewayApi, SessionChange } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { FileDiff, FilePath } from './code-change';

/** Diffs open at once when this few files changed, as a pull request's do. */
const OPEN_FILES = 3;
/**
 * The most files whose diffs are read, each its own request: a checkout with more lists the rest
 * by name. Up to 2000 can be listed, and reading all of them would hold the gateway for each.
 */
const MAX_DIFFS = 100;

/** A row of the list: where it was saved too, when it is a run's diff and not the checkout's. */
export type ListedFile = SessionChange & { runId?: string; toolCallId?: string };

type Read = { change?: SessionChange; failed?: string };

/**
 * Each listed file's diff, read from the checkout as it is now; a saved one already has its own.
 * They are read again as the list is, when the agent works and the window comes back. The figures
 * are given only once every file is read, so they are never a part passing for the whole.
 */
export function useFileDiffs({
  api,
  profileId,
  sessionId,
  worktree,
  files,
  live,
}: {
  api: Pick<GatewayApi, 'sessionChanges'>;
  profileId: string;
  sessionId: string;
  worktree: string | undefined;
  files: ListedFile[];
  live: boolean;
}) {
  const read = files.slice(0, MAX_DIFFS);
  const results = useQueries({
    queries: read.map((file) => ({
      queryKey: keys.sessionChanges(profileId, sessionId, file.path, worktree),
      queryFn: () => api.sessionChanges(profileId, sessionId, file.path, undefined, worktree),
      enabled: live && !file.diff,
      refetchOnWindowFocus: true,
    })),
  });
  const diffs = new Map<string, Read>();
  read.forEach((file, index) => {
    const result = results[index];
    if (file.diff || !live) {
      diffs.set(file.path, { change: file });
      return;
    }
    diffs.set(file.path, {
      change: result?.data?.files[0],
      ...(result?.isError && !result.data
        ? {
            failed:
              result.error instanceof Error ? result.error.message : 'The diff could not be read.',
          }
        : {}),
    });
  });
  const complete = files.length <= MAX_DIFFS && read.every((file) => diffs.get(file.path)?.change);
  const totals = complete
    ? read.reduce(
        (sum, file) => {
          const diff = diffs.get(file.path)?.change?.diff;
          return {
            additions: sum.additions + (diff?.additions ?? 0),
            deletions: sum.deletions + (diff?.deletions ?? 0),
          };
        },
        { additions: 0, deletions: 0 },
      )
    : undefined;

  return { diffs, totals };
}

/**
 * What changed, as a pull request's Changes shows it: each file's diff laid into the panel, folded
 * or open, with a mark to say it has been looked at. A file with no diff to show says why on its
 * own line. `readLines` reads a file as it is now, to bring in the lines its diff leaves out.
 */
export function ChangedFiles({
  files,
  total,
  diffs,
  reviewScope,
  readLines,
}: {
  files: ListedFile[];
  /** How many files changed in all, filtered or not: few enough, and every diff starts open. */
  total: number;
  diffs: Map<string, Read>;
  reviewScope: string;
  readLines?: ((path: string) => Promise<string[]>) | undefined;
}) {
  return (
    <div className="-mx-(--inspector-inset) grid grid-cols-1">
      {files.map((file) => {
        const read = diffs.get(file.path);
        const diff = read?.change?.diff;
        if (diff) {
          return (
            <FileDiff
              key={file.path}
              diff={diff}
              open={total <= OPEN_FILES}
              flat
              reviewScope={reviewScope}
              readLines={
                readLines && file.status !== 'deleted' ? () => readLines(file.path) : undefined
              }
            />
          );
        }
        return (
          <p key={file.path} className="code-diff-unshown">
            <FilePath path={file.path} />
            <span className="ml-auto shrink-0 font-sans text-xs text-muted">
              {!read
                ? `Not shown: more than ${MAX_DIFFS} files changed`
                : (read.failed ??
                  read.change?.unavailable ??
                  (read.change ? 'No text diff' : 'Loading…'))}
            </span>
          </p>
        );
      })}
    </div>
  );
}
