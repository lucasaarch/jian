'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Markdown } from '../components/ui/markdown';
import { Action, Overlay, SettingsRow, StatusPill } from '../kit';
import { date } from '../lib/format';
import { panelApi } from '../lib/query/client';
import { queries } from '../lib/query/profile';

type Note = { version: string; date: string; summary?: string | null; body: string };

/** The notes, newest first; with more than one, each under its version and date. */
function Notes({ notes, headed }: { notes: Note[]; headed: boolean }) {
  return (
    <div className="grid gap-6">
      {notes.map((note) => (
        <section key={note.version} className="grid gap-2" aria-label={`Jian ${note.version}`}>
          {headed && (
            <h3 className="flex items-baseline gap-2 text-sm font-semibold text-ink">
              {note.version}
              <small className="font-normal text-muted">{date(note.date)}</small>
            </h3>
          )}
          {headed && note.summary && <p className="text-sm">{note.summary}</p>}
          <div className="markdown text-sm leading-relaxed text-ink/90">
            <Markdown text={note.body} />
          </div>
        </section>
      ))}
    </div>
  );
}

function NotesOverlay({
  open,
  onOpenChange,
  title,
  description,
  close,
  notes,
  headed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string | null | undefined;
  close: string;
  notes: Note[];
  headed: boolean;
}) {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title={title} size="page">
      <div className="grid w-full gap-6 p-7 phone:p-5">
        <header className="grid gap-1 pr-8">
          <h2 className="font-sans text-xl font-semibold tracking-tight">{title}</h2>
          {description && <p className="text-sm">{description}</p>}
        </header>
        <Notes notes={notes} headed={headed} />
        <div className="flex justify-end">
          <Action tone="primary" onClick={() => onOpenChange(false)}>
            {close}
          </Action>
        </div>
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
      close="Got it"
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
          : 'Every release up to this one, newest first.'
      }
    >
      <Action tone="outline" size="small" onClick={() => setOpen(true)} disabled={!releases}>
        Read
      </Action>
      <NotesOverlay
        open={open}
        onOpenChange={setOpen}
        title={behind > 0 ? `What's new since Jian ${releases?.version ?? ''}` : 'Release notes'}
        description={
          releases?.version ? undefined : 'This build has no version, so it has no notes to show.'
        }
        close="Close"
        notes={notes}
        headed
      />
    </SettingsRow>
  );
}
