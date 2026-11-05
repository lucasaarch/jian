'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileCode2, GitBranch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Action, Picker, PickerRow, Skeleton, SkeletonLine, SkeletonRegion } from '../../kit';
import type { GatewayApi, SessionChange } from '../../lib/api';
import { GatewayAnswer } from '../../lib/api/result';
import { subscribe } from '../../lib/events';
import { keys } from '../../lib/query/keys';
import { useCrew } from '../../lib/stores/crew';
import { DiffSkeleton, FileDiff } from './code-change';
import { useDrawerFocus } from './crew';
import { FileFilter, WrapSwitch } from './diff-controls';
import { InspectorBar, InspectorBody } from './inspector';
import { InspectorContent } from './inspector-host';

type DrawerApi = Pick<GatewayApi, 'sessionChanges' | 'timeline'> &
  Partial<Pick<GatewayApi, 'sessionWorktrees'>>;

/**
 * How often an open list asks again, in ms. Events tell of what the agent changes; only asking
 * notices what changed outside it, as the owner editing the same checkout.
 */
const READ_AGAIN_MS = 10_000;
/** How long a burst of events is gathered into one read, in ms. */
const GATHER_MS = 500;
/** A row of the list: where it was saved too, when it is a run's diff and not the checkout's. */
type ListedFile = SessionChange & { runId?: string; toolCallId?: string };

/**
 * The files a conversation with no project changed, from the diffs its turns saved: each file
 * once, as its last change left it, the latest first. Only what went through has a diff to open.
 */
function savedFiles(timeline: Awaited<ReturnType<DrawerApi['timeline']>>): ListedFile[] {
  const files = new Map<string, ListedFile>();

  for (const { runId, steps } of timeline) {
    for (const step of steps) {
      if (step.status !== 'done' || !step.diff) continue;
      // Taken out first, so a file changed again moves to where its latest change belongs.
      files.delete(step.diff.path);
      files.set(step.diff.path, {
        path: step.diff.path,
        status: step.diff.created ? 'added' : 'modified',
        runId,
        toolCallId: step.toolCallId,
      });
    }
  }

  return [...files.values()].reverse();
}

/** Any part of the path or of the one it was renamed from, whatever its case. */
const matches = (file: SessionChange, words: string) =>
  file.path.toLowerCase().includes(words) || file.previousPath?.toLowerCase().includes(words);

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'The changes could not be read.';
}

/**
 * The gateway answered that it cannot read this checkout: an older gateway, a conversation with
 * none, or a machine that is offline (503). Trying again now will not change that, and what its
 * turns saved is still worth reading; the list is asked again on its own and takes over once it
 * answers. A dropped connection or a failed read is different: a saved diff would pass for the
 * current file.
 */
const cannotRead = (error: unknown) =>
  error instanceof GatewayAnswer &&
  (error.status === 404 || error.status === 409 || error.status === 503);

/** A read that failed and may yet work: what happened, and a way to ask again. */
function Trouble({ query }: { query: { error: unknown; refetch: () => unknown } }) {
  return (
    <div className="grid justify-items-start gap-1 pt-2">
      <p className="text-sm font-medium text-ink">Could not read the changes</p>
      <p role="alert" className="text-sm text-muted">
        {messageOf(query.error)}
      </p>
      <div className="pt-2">
        <Action tone="outline" size="small" onClick={() => void query.refetch()}>
          Try again
        </Action>
      </div>
    </div>
  );
}

function Status({ file }: { file: SessionChange }) {
  return (
    <span className="shrink-0 rounded-full border border-glass-edge px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
      {file.status}
    </span>
  );
}

/** The rows of changed files, with their widths varied so they read as paths. */
function ListSkeleton() {
  return (
    <SkeletonRegion label="Loading changed files…" className="grid gap-1.5 pt-2">
      {['w-3/5', 'w-4/5', 'w-1/2', 'w-2/3'].map((width) => (
        <div key={width} className="flex items-center gap-2 px-2.5 py-2">
          <Skeleton className="size-3.5 shrink-0" />
          <div className="min-w-0 flex-1 text-xs">
            <SkeletonLine className={width} />
          </div>
          <Skeleton className="h-4 w-14 shrink-0 rounded-full" />
        </div>
      ))}
    </SkeletonRegion>
  );
}

/**
 * The Inspector's Changes tab. A project reads its current checkout; without one, a file opened
 * from a run summary reads that run's saved tool diff instead. The list never stores diff contents.
 */
export function ChangesDrawer({ api, profileId }: { api: DrawerApi; profileId: string }) {
  const tabs = useCrew((state) => state.tabs);
  const following = useCrew((state) => state.following);
  const machineId = useCrew((state) => state.machineId);
  const closer = useRef<HTMLButtonElement>(null);
  const [wrap, setWrap] = useState(false);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string>();
  const [picking, setPicking] = useState(false);
  const client = useQueryClient();
  const tab = tabs.find((item) => item.kind === 'changes' && item.key === following);
  const sessionId = tab?.kind === 'changes' ? tab.sessionId : undefined;
  const projectId = tab?.kind === 'changes' ? tab.projectId : undefined;
  const runId = tab?.kind === 'changes' ? tab.runId : undefined;
  const toolCallId = tab?.kind === 'changes' ? tab.toolCallId : undefined;
  const path = tab?.kind === 'changes' ? tab.path : undefined;

  // A worktree is read like a project's checkout, on the gateway's disk or through the machine it
  // is on. Only those where the conversation works are read unasked, as the gateway picks them;
  // a machine conversation's gateway worktrees are offered by name, since its tools no longer
  // work there, and one on a machine it no longer targets is not read at all. An older gateway
  // answers none, and one that cannot reach the machine says so, which leaves the timeline.
  const worktrees = useQuery({
    queryKey: keys.sessionWorktrees(profileId, sessionId ?? ''),
    queryFn: async () => (await api.sessionWorktrees?.(profileId, sessionId ?? '')) ?? [],
    enabled: Boolean(sessionId),
  });
  const place = machineId ?? 'gateway';
  const atPlace = (worktrees.data ?? []).filter((item) => item.place === place);
  const left = machineId ? (worktrees.data ?? []).filter((item) => item.place === 'gateway') : [];
  const here = [...atPlace, ...left];
  // The one chosen; until then the first where the conversation works, so the list never waits
  // on an answer. With none there, nothing is named and the gateway reads the machine's clone.
  const worktree = here.find((item) => item.name === picked)?.name ?? atPlace[0]?.name;
  // What is read when no worktree is named, offered beside the gateway's left-behind ones.
  const unnamed =
    machineId && !atPlace.length && left.length
      ? projectId
        ? "The project's checkout on the machine"
        : 'What this conversation saved'
      : undefined;
  // Asking before the worktrees are known would be refused when there are several.
  const known = !worktrees.isPending;
  const readable = Boolean(projectId || worktree);

  const listing = useQuery({
    queryKey: keys.sessionChanges(profileId, sessionId ?? '', undefined, worktree),
    queryFn: () => api.sessionChanges(profileId, sessionId ?? '', undefined, undefined, worktree),
    enabled: Boolean(sessionId && readable && known),
    refetchInterval: READ_AGAIN_MS,
    refetchOnWindowFocus: true,
  });
  const selected = useQuery({
    queryKey: keys.sessionChanges(profileId, sessionId ?? '', path, worktree),
    queryFn: () => api.sessionChanges(profileId, sessionId ?? '', path, undefined, worktree),
    enabled: Boolean(
      sessionId && readable && path && listing.data?.files.some((file) => file.path === path),
    ),
    refetchInterval: READ_AGAIN_MS,
    refetchOnWindowFocus: true,
  });
  const pathIsCurrent = Boolean(listing.data?.files.some((file) => file.path === path));
  const unreadable = Boolean(readable && !listing.data && cannotRead(listing.error));
  // Reads the checkout as it is now; otherwise, what the conversation's turns saved is all there is.
  const live = Boolean(readable && !unreadable);
  const needsHistory = Boolean(
    sessionId && runId && path && (!live || (listing.isSuccess && !pathIsCurrent)),
  );
  const history = useQuery({
    // Named by its turn: a conversation's timeline otherwise covers only its latest turns, and a
    // link from an older one would call a diff that was saved unavailable.
    queryKey: [...keys.sessionTimeline(profileId, sessionId ?? ''), runId],
    queryFn: () => api.timeline(profileId, sessionId ?? '', runId ? [runId] : undefined),
    enabled: needsHistory,
  });
  // A conversation with no project has no checkout to list: what its turns saved is its list.
  const saved = useQuery({
    queryKey: keys.sessionTimeline(profileId, sessionId ?? ''),
    queryFn: () => api.timeline(profileId, sessionId ?? ''),
    enabled: Boolean(sessionId && known && !live && !path),
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
  const listed = live ? listing : saved;
  // Reads wait while the gateway is away, with nothing on the way: an outline would never end.
  const held = [worktrees, listed, selected, history].some(
    (query) => !query.data && query.fetchStatus === 'paused',
  );
  const truncated = Boolean(live && listing.data?.truncated);
  const files: ListedFile[] = live ? (listing.data?.files ?? []) : savedFiles(saved.data ?? []);
  const words = filter.trim().toLowerCase();
  const shown = words ? files.filter((item) => matches(item, words)) : files;

  useDrawerFocus(opened ? following : undefined, closer);

  // What the agent does changes the files: read again as its conversation moves, with nothing to
  // press. An event names its conversation only when it can, so one that names none counts.
  useEffect(() => {
    if (!sessionId) return;
    let timer: ReturnType<typeof setTimeout>;
    const stop = subscribe((event) => {
      if (!event.type.startsWith('run.') && !event.type.startsWith('session.')) return;
      const about = (event.data as { sessionId?: string } | undefined)?.sessionId;
      if (about && about !== sessionId) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void client.invalidateQueries({ queryKey: keys.sessionChanges(profileId, sessionId) });
        void client.invalidateQueries({ queryKey: keys.sessionTimeline(profileId, sessionId) });
      }, GATHER_MS);
    });

    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [client, profileId, sessionId]);

  if (tab?.kind !== 'changes' || !sessionId) return null;
  const choose = (file?: ListedFile, opener?: HTMLElement | null) =>
    useCrew.getState().showChanges({
      path: file?.path,
      runId: file?.runId,
      toolCallId: file?.toolCallId,
      opener,
    });
  const list = listed.isPending ? (
    <ListSkeleton />
  ) : listed.isError && !listed.data ? (
    <Trouble query={listed} />
  ) : files.length === 0 ? (
    <p className="pt-3 text-sm text-muted">
      {live
        ? 'No uncommitted changes in this project.'
        : 'No file changes were saved in this conversation.'}
    </p>
  ) : (
    <div className="grid gap-2 pt-2">
      <ul className="grid gap-1.5">
        {shown.map((item) => (
          <li key={item.path}>
            <button
              type="button"
              className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-transparent px-2.5 py-2 text-left transition-colors hover:bg-glass-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-ink/30"
              onClick={(event) => choose(item, event.currentTarget)}
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
      {!shown.length && (
        <p className="pt-1 text-sm text-muted">
          No changed file matches “{filter.trim()}”.
          {truncated ? ' It may be beyond what is listed, since this list is cut short.' : ''}
        </p>
      )}
    </div>
  );

  return (
    <InspectorContent>
      <aside className="crew-drawer" aria-label="Changes" data-wrap={wrap || undefined}>
        {/* The tab says this is Changes, and the file's own heading says which file. */}
        <InspectorBar closer={closer} spread>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {!path && listed.data && (
              <span className="changes-fade shrink-0 text-xs whitespace-nowrap text-muted">
                {words ? `${shown.length} of ` : ''}
                {files.length} {files.length === 1 ? 'changed file' : 'changed files'}
                {truncated ? ' · list truncated' : ''}
              </span>
            )}
            {/* One place in the line, so the field stays the same element from a file to the list
              and the keyboard stays in it. */}
            {(here.length > 1 || unnamed) && (
              <Picker
                label="Worktree"
                open={picking}
                onOpenChange={setPicking}
                trigger={
                  <>
                    <GitBranch size={12} aria-hidden="true" />
                    <span className="truncate">{worktree ?? unnamed}</span>
                  </>
                }
              >
                {unnamed && (
                  <PickerRow
                    label={unnamed}
                    selected={!worktree}
                    onPick={() => {
                      setPicked(undefined);
                      setPicking(false);
                      if (path) choose();
                    }}
                  />
                )}
                {here.map((item) => (
                  <PickerRow
                    key={item.name}
                    label={item.name}
                    detail={`${item.branch} → ${item.base}`}
                    selected={item.name === worktree}
                    onPick={() => {
                      setPicked(item.name);
                      setPicking(false);
                      // Another checkout has other files: the one open may not be among them.
                      if (path) choose();
                    }}
                  />
                ))}
              </Picker>
            )}
            <FileFilter
              value={filter}
              onChange={(next) => {
                setFilter(next);
                // What is typed is looked for in the list, so a file open gives way to it.
                if (path && next) choose();
              }}
            />
            {path && <WrapSwitch wrap={wrap} setWrap={setWrap} />}
          </div>
        </InspectorBar>

        <InspectorBody className="changes-state px-(--inspector-inset)">
          {unreadable && (
            <p className="pt-2 text-xs text-muted">
              Showing what this conversation saved. {messageOf(listing.error)}
            </p>
          )}
          {held ? (
            <p role="status" className="pt-3 text-sm text-muted">
              Waiting for the gateway to answer.
            </p>
          ) : live ? (
            path ? (
              <div className="changes-state grid gap-3 pt-2">
                {listing.isPending ? (
                  <DiffSkeleton />
                ) : listing.isError && !listing.data ? (
                  <Trouble query={listing} />
                ) : !file && (selected.isFetching || (needsHistory && history.isFetching)) ? (
                  <DiffSkeleton />
                ) : needsHistory && history.isError && !file ? (
                  <Trouble query={history} />
                ) : file?.unavailable ? (
                  <p className="text-sm text-muted">{file.unavailable}</p>
                ) : file?.diff ? (
                  <div className="-mx-(--inspector-inset)">
                    <FileDiff
                      key={path}
                      diff={file.diff}
                      open
                      flat
                      reviewScope={`session:${sessionId}`}
                      readLines={
                        // A saved diff is of a file that may be long gone from the checkout.
                        file === current && file.status !== 'deleted' && sessionId && path
                          ? () =>
                              api
                                .sessionChanges(profileId, sessionId, path, true, worktree)
                                .then((read) => read.files[0]?.lines ?? [])
                          : undefined
                      }
                    />
                  </div>
                ) : needsHistory && history.isSuccess ? (
                  <p className="text-sm text-muted">
                    This file is no longer changed in the current checkout, and its saved diff is
                    unavailable.
                  </p>
                ) : selected.isError ? (
                  <Trouble query={selected} />
                ) : !pathIsCurrent ? (
                  <p className="text-sm text-muted">
                    This file is no longer changed in the current checkout.
                  </p>
                ) : null}
              </div>
            ) : (
              list
            )
          ) : path ? (
            <div className="changes-state grid gap-3 pt-2">
              {!recorded?.diff && history.isFetching ? (
                <DiffSkeleton />
              ) : history.isError ? (
                <Trouble query={history} />
              ) : recorded?.diff ? (
                <div className="-mx-(--inspector-inset)">
                  <FileDiff
                    key={path}
                    diff={recorded.diff}
                    open
                    flat
                    reviewScope={`session:${sessionId}`}
                  />
                </div>
              ) : (
                <p className="text-sm text-muted">The saved diff for this file is unavailable.</p>
              )}
            </div>
          ) : (
            list
          )}
        </InspectorBody>
      </aside>
    </InspectorContent>
  );
}
