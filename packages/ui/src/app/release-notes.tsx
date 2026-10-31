'use client';

import type { ReleaseMedia } from '@jian/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type { LoadedMedia } from '../components/sessions/media';
import { MediaViewer } from '../components/sessions/viewer';
import { Markdown, MarkdownImages, MarkdownLink } from '../components/ui/markdown';
import { Action, Overlay, SettingsRow, Skeleton, StatusPill } from '../kit';
import { date } from '../lib/format';
import { panelApi } from '../lib/query/client';
import { queries } from '../lib/query/profile';

type Note = { version: string; date: string; summary?: string | null; body: string };

/** The notes, newest first; with more than one, each under its version and date. */
function Notes({ notes, headed }: { notes: Note[]; headed: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-6">
      {notes.map((note) => (
        <section
          key={note.version}
          className="grid grid-cols-1 gap-2"
          aria-label={`Jian ${note.version}`}
        >
          {headed && (
            <h3 className="flex items-baseline gap-2 text-sm font-semibold text-ink">
              {note.version}
              <small className="font-normal text-muted">{date(note.date)}</small>
            </h3>
          )}
          {headed && note.summary && <p className="text-sm">{note.summary}</p>}
          {/* A long path or command breaks across lines here rather than running off the side. */}
          <div className="markdown min-w-0 text-sm leading-relaxed text-ink/90 [overflow-wrap:anywhere]">
            <Markdown text={note.body} />
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * A picture in a note, read from the gateway's own copy so that it works with no internet and
 * asks no one else for anything. A click opens it over everything, as a chat's pictures do. An
 * address elsewhere, as a release on GitHub writes it, stays a link: it is not fetched.
 */
function NoteImage({
  src,
  alt,
  view,
}: {
  src: string;
  alt: string;
  view: (media: LoadedMedia) => void;
}) {
  const file = src.startsWith('media/') ? src.slice('media/'.length) : undefined;
  // Not through the query cache: a desktop app keeps that on disk, and these come with the release.
  const [data, setData] = useState<ReleaseMedia>();
  const [isError, setIsError] = useState(false);
  useEffect(() => {
    if (!file) return;
    let live = true;
    panelApi()
      .releaseMedia(file)
      .then((read) => live && setData(read))
      .catch(() => live && setIsError(true));
    return () => {
      live = false;
    };
  }, [file]);

  if (!file) return /^https?:\/\//.test(src) ? <MarkdownLink href={src} label={alt || src} /> : alt;
  if (isError) return <span className="text-muted">{alt}</span>;
  if (!data) return <Skeleton className="my-2 h-48 w-full rounded-xl" />;

  const url = `data:${data.mimeType};base64,${data.data}`;
  const media = {
    id: data.file,
    mimeType: data.mimeType,
    bytes: data.bytes,
    data: data.data,
    name: alt || data.file,
    url,
  } as LoadedMedia;

  return (
    <button
      type="button"
      aria-label={`Open ${alt || 'image'}`}
      onClick={() => view(media)}
      className="my-2 block w-full cursor-zoom-in overflow-hidden rounded-xl border border-glass-edge"
    >
      <img src={url} alt={alt} className="block w-full" />
    </button>
  );
}

function NotesOverlay({
  open,
  onOpenChange,
  title,
  description,
  notes,
  headed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string | null | undefined;
  notes: Note[];
  headed: boolean;
}) {
  const [viewing, setViewing] = useState<LoadedMedia>();
  const images = useCallback(
    (src: string, alt: string) => <NoteImage src={src} alt={alt} view={setViewing} />,
    [],
  );

  return (
    <Overlay
      open={open}
      // Escape and a click outside belong to the picture over the notes while one is open.
      onOpenChange={(next) => {
        if (!viewing) onOpenChange(next);
      }}
      title={title}
      size="page"
    >
      {/* One column as wide as the overlay: left to its content, a long line in a note widens it
          and the whole note goes sideways. */}
      <div className="grid w-full grid-cols-1 gap-6 p-7 phone:p-5">
        <header className="grid gap-1 pr-8">
          <h2 className="font-sans text-xl font-semibold tracking-tight">{title}</h2>
          {description && <p className="text-sm">{description}</p>}
        </header>
        <MarkdownImages.Provider value={images}>
          <Notes notes={notes} headed={headed} />
        </MarkdownImages.Provider>
        {/* Afloat at the corner however long the notes run, and at their end once there. */}
        <Action
          tone="primary"
          className="sticky bottom-5 justify-self-end shadow-lg phone:bottom-[max(1.25rem,env(safe-area-inset-bottom))]"
          onClick={() => onOpenChange(false)}
        >
          Got it
        </Action>
        {viewing && <MediaViewer items={[viewing]} start={0} close={() => setViewing(undefined)} />}
      </div>
    </Overlay>
  );
}

/**
 * What changed, once, after an update. Closing it is the owner saying they read it, and the
 * gateway keeps that mark, so the same notes do not open again on another browser.
 */
export function ReleaseNotes() {
  const client = useQueryClient();
  const releases = useQuery(queries.releases()).data;
  const unseen = releases?.unseen ?? [];
  const [latest] = unseen;

  const read = () => {
    client.setQueryData(queries.releases().queryKey, (state) =>
      state ? { ...state, unseen: [] } : state,
    );
    void panelApi()
      .markReleasesSeen()
      .catch(() => {});
  };

  return (
    <NotesOverlay
      open={unseen.length > 0}
      onOpenChange={(open) => !open && read()}
      title={`What's new in Jian ${releases?.version ?? latest?.version ?? ''}`}
      description={unseen.length === 1 ? latest?.summary : undefined}
      notes={unseen}
      headed={unseen.length > 1}
    />
  );
}

/**
 * The release history, as a row of the settings: every release this installation ran up to
 * now, or what is new since it when it is behind. Reading it marks nothing.
 */
export function ReleaseNotesRow() {
  const releases = useQuery(queries.releases()).data;
  const [open, setOpen] = useState(false);
  const behind = releases?.behind ?? 0;
  const notes = behind > 0 ? (releases?.updates ?? []) : (releases?.notes ?? []);

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          Release notes
          {behind > 0 && (
            <StatusPill tone="warn">{`${behind} ${behind === 1 ? 'release' : 'releases'} behind`}</StatusPill>
          )}
        </span>
      }
      description={
        behind > 0
          ? 'Update Jian through your deployment method after reading what changed.'
          : releases?.version
            ? 'Every release up to this one, newest first.'
            : 'The latest release.'
      }
    >
      <Action tone="outline" size="small" onClick={() => setOpen(true)} disabled={!releases}>
        Read
      </Action>
      <NotesOverlay
        open={open}
        onOpenChange={setOpen}
        title={behind > 0 ? `What's new since Jian ${releases?.version ?? ''}` : 'Release notes'}
        description={notes.length > 0 ? undefined : 'No release notes came with this build.'}
        notes={notes}
        headed
      />
    </SettingsRow>
  );
}
