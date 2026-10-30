'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { date } from '../../lib/format';
import { panelApi } from '../../lib/query/client';
import { queries } from '../../lib/query/profile';
import { useShell } from '../../lib/stores/shell';
import { Button } from '../ui';
import { Markdown } from '../ui/markdown';
import { Modal } from '../ui/modal';

/** How the sidebar opens the notes on purpose: the dialog opens over any page of the shell. */
export const useReleaseNotes = () => {
  const setReleaseNotes = useShell((state) => state.setReleaseNotes);

  return useCallback(() => setReleaseNotes(true), [setReleaseNotes]);
};

/**
 * Opens once after an update with what changed, and again whenever the owner asks. Closing the
 * first is the owner saying they read it, and the gateway keeps that mark, so the same notes do
 * not open again on another browser. Opened on purpose it is the history, every release this
 * installation ran up to now — the gateway leaves out candidates on a stable version — and
 * reading it again marks nothing.
 */
export function ReleaseNotes() {
  const client = useQueryClient();
  const { data: releases } = useQuery(queries.releases());
  const asked = useShell((state) => state.releaseNotes);
  const setAsked = useShell((state) => state.setReleaseNotes);

  const close = () => {
    if (asked) {
      setAsked(false);
      return;
    }

    client.setQueryData(queries.releases().queryKey, (state) =>
      state ? { ...state, unseen: [] } : state,
    );
    void panelApi()
      .markReleasesSeen()
      .catch(() => {});
  };

  const behind = releases?.behind ?? 0;
  const shown = asked
    ? behind > 0
      ? (releases?.updates ?? [])
      : (releases?.notes ?? [])
    : (releases?.unseen ?? []);
  const open = asked || shown.length > 0;
  const many = asked || shown.length > 1;
  const [latest] = shown;

  if (!open) return null;

  return (
    <Modal
      title={
        asked
          ? behind > 0
            ? `What's new since Jian ${releases?.version ?? ''}`
            : 'Release notes'
          : `What's new in Jian ${releases?.version ?? latest?.version ?? ''}`
      }
      {...(asked
        ? {
            description:
              behind > 0
                ? `${behind} newer ${behind === 1 ? 'release is' : 'releases are'} available. Update Jian through your deployment method after reviewing these notes.`
                : releases?.version
                  ? `Every release up to ${releases.version}, newest first.`
                  : 'This build has no version, so it has no notes to show.',
          }
        : latest?.summary
          ? { description: latest.summary }
          : {})}
      close={close}
      footer={
        <Button type="button" onClick={close}>
          {asked ? 'Close' : 'Got it'}
        </Button>
      }
    >
      <div className="release-notes">
        {shown.map((note) => (
          <section key={note.version}>
            {many && (
              <h2>
                {note.version} <small>{date(note.date)}</small>
              </h2>
            )}
            {many && note.summary && <p>{note.summary}</p>}
            <Markdown text={note.body} />
          </section>
        ))}
      </div>
    </Modal>
  );
}
