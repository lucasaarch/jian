'use client';

import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { HoverTip, iconButton, SkeletonLine, SkeletonRegion, StatusPill } from '../../../kit';
import { usePhone } from '../../../lib/phone';
import { useCrew } from '../../../lib/stores/crew';
import { useLayout } from '../../../lib/stores/layout';
import { useReading } from '../../../lib/stores/reading';
import { highlightLines } from '../../ui/highlight';
import { Markdown } from '../../ui/markdown';
import { languageOf } from '../preview';
import { CodeView } from './code-view';
import { FileDiffView } from './file-diff';
import { FileOptions } from './file-options';
import { FindBar, useFind } from './find-bar';
import { type OpenFile, useFiles } from './store';
import { fileId, markOf } from './tree';
import {
  type FilesApi,
  useDiffable,
  useFilesFollow,
  useSessionFile,
  useSessionFiles,
} from './use-files';

const MARKDOWN = /\.(md|mdx|markdown)$/i;
/**
 * Past this many lines a file is drawn without colours. The highlighter has its own limit in
 * characters (highlight.ts); a long file of short lines is under it and still a second of work.
 */
const HIGHLIGHT_LINES = 10_000;
const NO_LINES: string[] = [];
const FIELD = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** Something open over the page that has the keyboard: its Escape is not the viewer's. */
const OVERLAY = '[role=dialog], [aria-modal=true], [role=menu], [role=listbox]';

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** A few lines of code still on their way. */
function CodeSkeleton() {
  return (
    <SkeletonRegion label="Loading file…" className="grid gap-2 px-6 pt-4 font-mono text-[12.5px]">
      {['w-1/3', 'w-1/2', 'w-2/5', 'w-3/5', 'w-1/4', 'w-1/2'].map((width, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed outline, never reordered.
        <SkeletonLine key={row} className={width} />
      ))}
    </SkeletonRegion>
  );
}

function Opened({
  api,
  profileId,
  sessionId,
  file,
}: {
  api: FilesApi;
  profileId: string;
  sessionId: string;
  file: OpenFile;
}) {
  const view = useRef<HTMLElement>(null);
  const phone = usePhone();
  const collapsed = useLayout((state) => state.chatList);
  const beside = useCrew((state) => state.opened) && !phone;
  const listing = useSessionFiles(api, profileId, sessionId);
  const read = useSessionFile(api, profileId, sessionId, file);
  const markdown = MARKDOWN.test(file.path);
  const [mode, setMode] = useState<'preview' | 'code'>(markdown ? 'preview' : 'code');
  // Prose is written in long lines; code is read with its lines whole. Both are kept apart, and
  // with the diff switch, so the next file opens as the owner last left one of its kind.
  const wrap = useReading((state) => (markdown ? state.wrapProse : state.wrap));
  const setWrap = useReading((state) => (markdown ? state.setWrapProse : state.setWrap));
  const diffOn = useReading((state) => state.diff);
  const setDiffOn = useReading((state) => state.setDiff);
  useFilesFollow(profileId, sessionId);

  const roots = listing.data?.roots;
  const root = roots?.find((item) => item.id === file.root);
  const change = root?.changes.find((item) => item.path === file.path);
  const diffable = useDiffable(roots?.[0]?.id)(file.root);
  const changes = api.sessionChanges;
  // Only while the file is changed: once it is committed or put back, it is shown as it is.
  const canDiff = Boolean(change && diffable && changes);
  const diffing = diffOn && canDiff;

  const text = read.data?.text;
  // Lines as an editor counts them: whatever ends them, and no empty one after the last.
  const body = useMemo(() => text?.replace(/\r\n?/g, '\n').replace(/\n$/, ''), [text]);
  const plain = useMemo(() => body?.split('\n') ?? NO_LINES, [body]);
  const lines = useMemo(
    () =>
      body === undefined
        ? []
        : highlightLines(
            body,
            plain.length > HIGHLIGHT_LINES ? undefined : languageOf('', file.path),
          ),
    [body, plain, file.path],
  );
  const find = useFind(plain);
  // Only a refusal ends in an error (use-files.ts); what was read before it is then out of date.
  const readable = Boolean(body) && !read.isError;
  const back = () => useFiles.getState().back(sessionId);
  // The rendered page has no lines to count matches on: the words are found in its source.
  const findWords = () => {
    // Find is offered only with no diff on screen; the saved switch is left as it is.
    setMode('code');
    find.show();
  };

  // No list of what it reads: the bar's state is new each render, and so is what a key does.
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector(OVERLAY)) return;
      const target = event.target instanceof Element ? event.target : null;
      const field = Boolean(target?.closest(FIELD));
      const mine = Boolean(target && view.current?.contains(target));
      // Taken here, before the Inspector and the app's own keys, which would close or search.
      const taken = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'f'
      ) {
        if (!readable) return;
        taken();
        findWords();
        return;
      }
      // A field elsewhere, as the Inspector's filter, keeps its own Escape.
      if (event.key !== 'Escape' || (field && !mine)) return;
      if (find.open) {
        taken();
        find.close();
        view.current?.focus({ preventScroll: true });
      } else if (!field) {
        taken();
        back();
      }
    };
    document.addEventListener('keydown', keys, true);
    return () => document.removeEventListener('keydown', keys, true);
  });

  const cut = file.path.lastIndexOf('/');
  const held = !read.data && read.fetchStatus === 'paused';

  return (
    <section ref={view} tabIndex={-1} className="file-view" aria-label={`File ${file.path}`}>
      {/* In the host's title bar, as tall as it is. With the Inspector beside it the window's own
          buttons are over the Inspector; alone, its end keeps clear of them (--chrome-end).
          Its ends are about as far from its buttons as its top and bottom are: 0.5rem. */}
      <header
        className={`flex h-(--chrome-top) shrink-0 items-center gap-1.5 border-b border-line ${beside ? 'pr-2' : 'pr-[calc(var(--chrome-end,0px)+1.25rem)]'} ${collapsed ? 'pl-52' : 'pl-2'} phone:h-auto phone:flex-wrap phone:py-2 phone:px-2`}
      >
        <HoverTip tip="Back to conversation" hoverOnly side="bottom">
          <button
            type="button"
            aria-label="Back to conversation"
            className={iconButton}
            onClick={back}
          >
            <ArrowLeft size={15} aria-hidden="true" />
          </button>
        </HoverTip>
        <h1 className="flex min-w-0 flex-1 items-baseline gap-1 font-mono text-xs phone:order-last phone:basis-full">
          <span className="min-w-0 truncate text-muted">
            {[root?.name, cut < 0 ? '' : file.path.slice(0, cut)].filter(Boolean).join('/')}
            {root?.name || cut >= 0 ? '/' : ''}
          </span>
          <span className="max-w-[70%] shrink-0 truncate font-medium text-ink">
            {file.path.slice(cut + 1)}
          </span>
        </h1>
        {change && (
          <StatusPill tone={markOf(change.status).tone}>{markOf(change.status).label}</StatusPill>
        )}
        <FileOptions
          path={file.path}
          text={readable ? text : undefined}
          mode={markdown && readable && !diffing ? mode : undefined}
          onModeChange={(next) => {
            setMode(next);
            if (next === 'preview') find.close();
          }}
          wrap={diffing || (readable && mode === 'code') ? wrap : undefined}
          onWrapChange={setWrap}
          onFind={readable && !diffing ? findWords : undefined}
          diff={canDiff ? diffing : undefined}
          onDiffChange={(next) => {
            setDiffOn(next);
            if (next) find.close();
          }}
        />
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {find.open && mode === 'code' && readable && !diffing && <FindBar find={find} />}
        {diffing && changes ? (
          <FileDiffView
            api={{ sessionChanges: changes }}
            profileId={profileId}
            sessionId={sessionId}
            root={file.root}
            path={file.path}
            wrap={wrap}
            version={read.dataUpdatedAt}
          />
        ) : held ? (
          <p role="status" className="px-6 pt-4 text-sm text-muted">
            Waiting for the gateway to answer.
          </p>
        ) : read.isError ? (
          // The gateway's own sentence, as for a file deleted since it was listed, rather than the
          // text last read of it. It is read again when the files are, so it goes away by itself
          // once it is no longer true.
          <p role="alert" className="px-6 pt-4 text-sm text-muted">
            {read.error instanceof Error ? read.error.message : 'The file could not be read.'}
          </p>
        ) : read.data?.unavailable ? (
          <p className="px-6 pt-4 text-sm text-muted">
            {read.data.unavailable}
            {read.data.size > 0 ? ` It is ${size(read.data.size)}.` : ''}
          </p>
        ) : body === '' ? (
          <p className="px-6 pt-4 text-sm text-muted">This file is empty.</p>
        ) : body !== undefined ? (
          mode === 'preview' ? (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain select-text">
              <article className="release-notes mx-auto w-full max-w-3xl px-6 pt-6 pb-12 text-ink phone:px-4">
                <Markdown text={body} />
              </article>
            </div>
          ) : (
            <CodeView lines={lines} wrap={wrap} hits={find.hits} current={find.current} />
          )
        ) : (
          <>
            <CodeSkeleton />
            {read.failureCount > 0 && (
              <p role="status" className="px-6 pt-3 text-xs text-muted">
                The file could not be read. Trying again…
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * A project file in the conversation's place, read only, with the Inspector still beside it.
 * Which file is the conversation's own (store.ts); nothing is drawn while it has none open.
 * Only its Back button and Escape lead back, and leaving the conversation does too: coming
 * back to a chat should show the chat.
 */
export function FileView({
  api,
  profileId,
  sessionId,
}: {
  api: FilesApi;
  profileId: string;
  sessionId: string;
}) {
  const file = useFiles((state) => state.open[sessionId]);

  useEffect(() => () => useFiles.getState().back(sessionId), [sessionId]);

  if (!file) return null;
  return (
    <Opened
      // Another file starts as its own kind is read: a Markdown page in Preview, nothing searched.
      key={fileId(file.root, file.path)}
      api={api}
      profileId={profileId}
      sessionId={sessionId}
      file={file}
    />
  );
}
