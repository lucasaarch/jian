'use client';

import { useMemo, useRef, useState } from 'react';
import { SearchField, Skeleton, SkeletonLine, SkeletonRegion } from '../../../kit';
import { usePhone } from '../../../lib/phone';
import { useCrew } from '../../../lib/stores/crew';
import { useDrawerFocus } from '../crew';
import { InspectorBar, InspectorBody } from '../inspector';
import { InspectorContent } from '../inspector-host';
import { FileList, FileTree } from './file-tree';
import { useFiles } from './store';
import {
  buildTree,
  countFiles,
  fileId,
  filterFiles,
  folderOpen,
  type TreeFile,
  visibleRows,
} from './tree';
import {
  type FilesApi,
  revealViewer,
  useDiffable,
  useFilesFollow,
  useSessionFiles,
} from './use-files';

const NONE: string[] = [];
const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/** Rows of a tree still on its way, stepped in as folders and their files are. */
function TreeSkeleton() {
  return (
    <SkeletonRegion label="Loading files…" className="grid gap-px pt-1">
      {['w-24', 'w-32 ml-3.5', 'w-40 ml-3.5', 'w-28', 'w-36 ml-3.5', 'w-20'].map((shape) => (
        <div key={shape} className="flex h-7 items-center gap-1.5 px-1.5 text-[13px]">
          <Skeleton className="size-3.5 shrink-0" />
          <SkeletonLine className={shape} />
        </div>
      ))}
    </SkeletonRegion>
  );
}

/**
 * The Inspector's Files tab: every file of the conversation's projects or worktrees, with what
 * changed marked. It only reads. A file opens in the conversation's place (file-view.tsx); a
 * deleted one has nothing to read, so it opens its diff in Changes. The list follows the
 * conversation's runs by itself (useFilesFollow), so nothing refreshes it by hand, and only
 * Changes narrows it to what changed.
 */
export function FilesDrawer({ api, profileId }: { api: FilesApi; profileId: string }) {
  const tabs = useCrew((state) => state.tabs);
  const following = useCrew((state) => state.following);
  const closer = useRef<HTMLButtonElement>(null);
  const phone = usePhone();
  const [words, setWords] = useState('');
  const tab = tabs.find((item) => item.kind === 'files' && item.key === following);
  const sessionId = tab?.kind === 'files' ? tab.sessionId : undefined;
  const listing = useSessionFiles(api, profileId, sessionId);
  const toggled = useFiles((state) => (sessionId && state.toggled[sessionId]) || NONE);
  const viewing = useFiles((state) => (sessionId ? state.open[sessionId] : undefined));
  const diffable = useDiffable(listing.data?.roots[0]?.id);

  useDrawerFocus(sessionId ? following : undefined, closer);
  useFilesFollow(profileId, sessionId);

  const roots = useMemo(() => buildTree(listing.data?.roots ?? []), [listing.data]);
  const counts = useMemo(() => countFiles(roots), [roots]);
  const turned = useMemo(() => new Set(toggled), [toggled]);
  const filtering = Boolean(words.trim());
  const rows = useMemo(
    () => (filtering ? [] : visibleRows(roots, turned)),
    [filtering, roots, turned],
  );
  const found = useMemo(
    () => (filtering ? filterFiles(roots, words) : undefined),
    [filtering, roots, words],
  );

  if (tab?.kind !== 'files' || !sessionId) return null;

  const opening = {
    current: viewing ? fileId(viewing.root, viewing.path) : undefined,
    diffable,
    onOpen: (file: TreeFile, opener: HTMLElement) => {
      if (file.status === 'deleted') {
        useCrew.getState().showChanges({ path: file.path, opener });
        return;
      }
      useFiles.getState().view(sessionId, { root: file.root, path: file.path });
      revealViewer(phone);
    },
  };
  const several = roots.length > 1;
  // A read the gateway is away for waits with nothing on the way: an outline would never end.
  const held = !listing.data && listing.fetchStatus === 'paused';

  return (
    <InspectorContent>
      <aside className="crew-drawer" aria-label="Files">
        <InspectorBar closer={closer} spread>
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <SearchField
              label="Filter files"
              value={words}
              onValueChange={setWords}
              // The first Escape takes back what was typed; only the next reaches the Inspector.
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || !words) return;
                event.stopPropagation();
                setWords('');
              }}
              className="h-7 flex-1"
            />
          </div>
        </InspectorBar>

        <InspectorBody className="px-(--inspector-inset)">
          {held ? (
            <p role="status" className="pt-3 text-sm text-muted">
              Waiting for the gateway to answer.
            </p>
          ) : listing.isError ? (
            // Only a refusal ends in an error (use-files.ts), and it has the gateway's own sentence:
            // a conversation on a machine, or one with no project. A tree read before it is out
            // of date; the files are read again by themselves, and it goes once it is not true.
            <p role="alert" className="pt-3 text-sm text-muted">
              {listing.error instanceof Error
                ? listing.error.message
                : 'The files could not be read.'}
            </p>
          ) : listing.data ? (
            <div className="grid gap-1.5 pt-1">
              <p className="px-1.5 text-xs text-muted">
                {found
                  ? `${plural(found.files.length + found.more, 'file', 'files')} of ${counts.files.toLocaleString('en-US')}`
                  : `${plural(counts.files, 'file', 'files')}${counts.changed ? ` · ${counts.changed.toLocaleString('en-US')} changed` : ''}`}
                {roots.some((root) => root.truncated) ? ' · list cut short' : ''}
              </p>
              {found ? (
                <>
                  <FileList
                    files={found.files}
                    rootName={(root) =>
                      several ? roots.find((item) => item.root === root)?.name : undefined
                    }
                    {...opening}
                  />
                  {found.more > 0 && (
                    <p className="px-1.5 text-xs text-muted">
                      {plural(found.more, 'more file', 'more files')}. Narrow the filter to see{' '}
                      {found.more === 1 ? 'it' : 'them'}.
                    </p>
                  )}
                  {!found.files.length && (
                    <p className="px-1.5 pt-1 text-sm text-muted">
                      {`No file matches “${words.trim()}”.`}
                      {roots.some((root) => root.truncated)
                        ? ' It may be beyond what is listed, since the list is cut short.'
                        : ''}
                    </p>
                  )}
                </>
              ) : (
                <FileTree
                  rows={rows}
                  isOpen={(folder) => folderOpen(folder, turned)}
                  onToggle={(folder) => useFiles.getState().toggle(sessionId, folder.id)}
                  {...opening}
                />
              )}
            </div>
          ) : (
            <>
              <TreeSkeleton />
              {listing.failureCount > 0 && (
                <p role="status" className="px-1.5 pt-2 text-xs text-muted">
                  The files could not be read. Trying again…
                </p>
              )}
            </>
          )}
        </InspectorBody>
      </aside>
    </InspectorContent>
  );
}
