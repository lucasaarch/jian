'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, FileCode2, RefreshCw } from 'lucide-react';
import { useRef } from 'react';
import { Action } from '../../kit';
import type { GatewayApi, SessionChange } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { useCrew } from '../../lib/stores/crew';
import { FileDiff } from './code-change';
import { useDrawerFocus } from './crew';
import { InspectorBar, InspectorBody } from './inspector';
import { InspectorContent } from './inspector-host';

type DrawerApi = Pick<GatewayApi, 'sessionChanges' | 'timeline'>;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'The changes could not be read.';
}

function Status({ file }: { file: SessionChange }) {
  return (
    <span className="shrink-0 rounded-full border border-glass-edge px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
      {file.status}
    </span>
  );
}

/**
 * The Inspector's Changes tab. A project reads its current checkout; without one, a file opened
 * from a run summary reads that run's saved tool diff instead. The list never stores diff contents.
 */
export function ChangesDrawer({ api, profileId }: { api: DrawerApi; profileId: string }) {
  const tabs = useCrew((state) => state.tabs);
  const following = useCrew((state) => state.following);
  const closer = useRef<HTMLButtonElement>(null);
  const tab = tabs.find((item) => item.kind === 'changes' && item.key === following);
  const sessionId = tab?.kind === 'changes' ? tab.sessionId : undefined;
  const projectId = tab?.kind === 'changes' ? tab.projectId : undefined;
  const runId = tab?.kind === 'changes' ? tab.runId : undefined;
  const toolCallId = tab?.kind === 'changes' ? tab.toolCallId : undefined;
  const path = tab?.kind === 'changes' ? tab.path : undefined;

  const listing = useQuery({
    queryKey: keys.sessionChanges(profileId, sessionId ?? ''),
    queryFn: () => api.sessionChanges(profileId, sessionId ?? ''),
    enabled: Boolean(sessionId && projectId),
  });
  const selected = useQuery({
    queryKey: keys.sessionChanges(profileId, sessionId ?? '', path),
    queryFn: () => api.sessionChanges(profileId, sessionId ?? '', path),
    enabled: Boolean(
      sessionId && projectId && path && listing.data?.files.some((file) => file.path === path),
    ),
  });
  const pathIsCurrent = Boolean(listing.data?.files.some((file) => file.path === path));
  const needsHistory = Boolean(
    sessionId && runId && path && (!projectId || (listing.isSuccess && !pathIsCurrent)),
  );
  const history = useQuery({
    queryKey: keys.sessionTimeline(profileId, sessionId ?? ''),
    queryFn: () => api.timeline(profileId, sessionId ?? ''),
    enabled: needsHistory,
  });
  const recordedStep = needsHistory
    ? history.data
        ?.find((timeline) => timeline.runId === runId)
        ?.steps.find(
          (step) => (!toolCallId || step.toolCallId === toolCallId) && step.diff?.path === path,
        )
    : undefined;
  const recorded: SessionChange | undefined = recordedStep?.diff
    ? {
        path: recordedStep.diff.path,
        diff: recordedStep.diff,
        status: recordedStep.diff.created ? 'added' : 'modified',
      }
    : undefined;
  const current = pathIsCurrent ? selected.data?.files[0] : undefined;
  const file = current?.diff || current?.unavailable ? current : recorded;
  const opened = Boolean(sessionId);

  useDrawerFocus(opened ? following : undefined, closer);

  if (tab?.kind !== 'changes' || !sessionId) return null;
  const choose = (nextPath?: string, opener?: HTMLElement | null) =>
    useCrew.getState().showChanges({ path: nextPath, opener });
  const refresh = () => {
    if (projectId) {
      void listing.refetch();
      if (pathIsCurrent) void selected.refetch();
    }
    if (needsHistory) void history.refetch();
  };

  return (
    <InspectorContent>
      <aside className="crew-drawer" aria-label="Changes">
        <InspectorBar closer={closer}>
          <FileCode2 size={14} aria-hidden="true" />
          <span className="truncate text-xs font-medium text-ink">Changes</span>
          <span className="min-w-0 flex-1" />
          {path ? (
            <button
              type="button"
              aria-label="Back to changed files"
              className="grid size-7 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-glass-hover hover:text-ink"
              onClick={() => choose()}
            >
              <ArrowLeft size={15} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Refresh changes"
            className="grid size-7 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-glass-hover hover:text-ink"
            onClick={refresh}
          >
            <RefreshCw size={14} />
          </button>
        </InspectorBar>

        <InspectorBody className="px-4">
          {projectId ? (
            path ? (
              <div className="grid gap-3 pt-2">
                <h2 className="break-all font-mono text-xs text-muted">{path}</h2>
                {listing.isPending ? (
                  <p className="text-sm text-muted">Loading diff…</p>
                ) : listing.isError ? (
                  <div className="grid justify-items-start gap-3">
                    <p role="alert" className="text-sm text-bad">
                      {messageOf(listing.error)}
                    </p>
                    <Action tone="outline" size="small" onClick={() => void listing.refetch()}>
                      Try again
                    </Action>
                  </div>
                ) : selected.isFetching || (needsHistory && history.isFetching) ? (
                  <p className="text-sm text-muted">Loading diff…</p>
                ) : needsHistory && history.isError && !file ? (
                  <div className="grid justify-items-start gap-3">
                    <p role="alert" className="text-sm text-bad">
                      {messageOf(history.error)}
                    </p>
                    <Action tone="outline" size="small" onClick={() => void history.refetch()}>
                      Try again
                    </Action>
                  </div>
                ) : file?.unavailable ? (
                  <p className="text-sm text-muted">{file.unavailable}</p>
                ) : file?.diff ? (
                  <FileDiff diff={file.diff} open />
                ) : needsHistory && history.isSuccess ? (
                  <p className="text-sm text-muted">
                    This file is no longer changed in the current checkout, and its saved diff is
                    unavailable.
                  </p>
                ) : selected.isError ? (
                  <div className="grid justify-items-start gap-3">
                    <p role="alert" className="text-sm text-bad">
                      {messageOf(selected.error)}
                    </p>
                    <Action tone="outline" size="small" onClick={() => void selected.refetch()}>
                      Try again
                    </Action>
                  </div>
                ) : !pathIsCurrent ? (
                  <p className="text-sm text-muted">
                    This file is no longer changed in the current checkout.
                  </p>
                ) : null}
              </div>
            ) : listing.isPending ? (
              <p className="pt-3 text-sm text-muted">Loading changed files…</p>
            ) : listing.isError ? (
              <div className="grid justify-items-start gap-3 pt-3">
                <p role="alert" className="text-sm text-bad">
                  {messageOf(listing.error)}
                </p>
                <Action tone="outline" size="small" onClick={() => void listing.refetch()}>
                  Try again
                </Action>
              </div>
            ) : listing.data.files.length === 0 ? (
              <p className="pt-3 text-sm text-muted">No uncommitted changes in this project.</p>
            ) : (
              <div className="grid gap-2 pt-2">
                <p className="text-xs text-muted">
                  {listing.data.files.length}{' '}
                  {listing.data.files.length === 1 ? 'changed file' : 'changed files'}
                  {listing.data.truncated ? ' · list truncated' : ''}
                </p>
                <ul className="grid gap-1.5">
                  {listing.data.files.map((item) => (
                    <li key={item.path}>
                      <button
                        type="button"
                        className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-transparent px-2.5 py-2 text-left transition-colors hover:bg-glass-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-ink/30"
                        onClick={(event) => choose(item.path, event.currentTarget)}
                      >
                        <FileCode2 size={14} aria-hidden="true" className="shrink-0 text-muted" />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                          {item.path}
                        </span>
                        <Status file={item} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : path ? (
            <div className="grid gap-3 pt-2">
              <h2 className="break-all font-mono text-xs text-muted">{path}</h2>
              {history.isFetching ? (
                <p className="text-sm text-muted">Loading saved diff…</p>
              ) : history.isError ? (
                <div className="grid justify-items-start gap-3">
                  <p role="alert" className="text-sm text-bad">
                    {messageOf(history.error)}
                  </p>
                  <Action tone="outline" size="small" onClick={() => void history.refetch()}>
                    Try again
                  </Action>
                </div>
              ) : recorded?.diff ? (
                <FileDiff diff={recorded.diff} open />
              ) : (
                <p className="text-sm text-muted">The saved diff for this file is unavailable.</p>
              )}
            </div>
          ) : (
            <p className="pt-3 text-sm text-muted">
              This conversation has no project. File links in a run summary open that run’s saved
              diff here.
            </p>
          )}
        </InspectorBody>
      </aside>
    </InspectorContent>
  );
}
