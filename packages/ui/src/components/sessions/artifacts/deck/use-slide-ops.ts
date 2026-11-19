'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { DeckSlidesEdit, SessionArtifact } from '../../../../lib/api';
import { keys } from '../../../../lib/query/keys';
import { type ArtifactsApi, artifactChanged, latestKnown } from '../use-artifacts';
import { layoutSlide, type SlideLayout } from './layouts';

/** One change to the slides, as the gateway takes it, before the version it is made from. */
type SlideChange = DeckSlidesEdit extends infer Change
  ? Change extends unknown
    ? Omit<Change, 'version' | 'editKey'>
    : never
  : never;

/** What is added after a slide: a layout in the deck's look, or a copy of that slide. */
export type NewSlide = SlideLayout | 'duplicate';

export type SlideOps = {
  /** A slide after the one at `index`, counted from 0, which is then in view. */
  add: (index: number, what: NewSlide) => void;
  remove: (index: number) => void;
  /** The slide at `from` to `to`, both counted from 0. */
  move: (from: number, to: number) => void;
  /** While a change is on its way: the next is made from what it makes, so it waits. */
  busy: boolean;
};

/**
 * The owner's changes to a deck's slides, each a version of theirs (POST `…/slides`). Each starts
 * by keeping what is being typed (`settle`, which ends that stretch), and is made from the
 * version in view, or, when that stretch was just saved, from the version it saved. The slides it
 * works from are read again from that version, never taken from the screen, so a slide copied or
 * given back by Undo is the one the gateway holds.
 *
 * The new version is read before it is shown, so the deck goes from one to the other with no
 * empty moment between. A deleted slide can be brought back with Undo, which adds it again where
 * it was, as a version of its own: every version stays in the history too.
 */
export function useSlideOps({
  api,
  profileId,
  artifact,
  from,
  settle,
  shown,
}: {
  api: ArtifactsApi;
  profileId: string;
  artifact: SessionArtifact;
  /** The version in view, or undefined while a stretch of editing holds one not saved yet. */
  from: number | undefined;
  /** Keeps what is being typed and ends that stretch; false when it could not be kept. */
  settle: () => Promise<boolean>;
  /** The latest version is to be shown, at this slide, counted from 0. */
  shown: (at: number) => void;
}): SlideOps {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const live = useRef({ api, profileId, artifact, from, settle, shown });
  live.current = { api, profileId, artifact, from, settle, shown };

  const read = useCallback(
    (version: number) => {
      const { api, profileId, artifact } = live.current;
      return client.fetchQuery({
        queryKey: keys.sessionArtifacts(profileId, artifact.sessionId, artifact.id, version),
        queryFn: () =>
          api.sessionArtifactVersion(profileId, artifact.sessionId, artifact.id, version),
        staleTime: Number.POSITIVE_INFINITY,
      });
    },
    [client],
  );

  const run = useCallback(
    async (
      make: (slides: readonly string[]) => { change: SlideChange; at: number },
    ): Promise<{ slides: readonly string[]; version: number } | undefined> => {
      if (running.current) return undefined;
      running.current = true;
      setBusy(true);
      try {
        const was = live.current.from;
        if (!(await live.current.settle())) return undefined;
        const { api, profileId, artifact } = live.current;
        const known = latestKnown(client, profileId, artifact);
        const base = was ?? known;
        const before = (await read(base)).slides ?? [];
        const { change, at } = make(before);
        const next = await api.editDeckSlides(profileId, artifact.sessionId, artifact.id, {
          ...change,
          version: base,
        } as DeckSlidesEdit);
        await read(next.version);
        artifactChanged(client, profileId, next);
        live.current.shown(at);
        if (next.version !== known + 1) {
          toast(
            `The agent wrote a newer version meanwhile. Your change is saved on top, as version ${next.version}.`,
          );
        }
        return { slides: before, version: next.version };
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'The slides could not be changed.');
        return undefined;
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [client, read],
  );

  const add = useCallback(
    (index: number, what: NewSlide) =>
      void run((slides) => {
        if (what === 'duplicate') {
          return { change: { op: 'duplicate', slide: index + 1 }, at: index + 1 };
        }
        // A title or a section opens the deck or a part of it: in the first slide's look, which
        // is most often how the agent opened it. The rest follow the slide they come after.
        const look =
          what === 'title' || what === 'section' ? slides[0] : (slides[index] ?? slides[0]);
        return {
          change: { op: 'add', html: layoutSlide(what, look), position: index + 2 },
          at: index + 1,
        };
      }),
    [run],
  );

  const remove = useCallback(
    (index: number) =>
      void run((slides) => ({
        change: { op: 'delete', slide: index + 1 },
        at: Math.max(0, Math.min(index, slides.length - 2)),
      })).then((done) => {
        const gone = done?.slides[index];
        if (gone === undefined) return;
        toast(`Slide ${index + 1} deleted.`, {
          action: {
            label: 'Undo',
            onClick: () =>
              void run(() => ({
                change: { op: 'add', html: gone, position: index + 1 },
                at: index,
              })),
          },
        });
      }),
    [run],
  );

  const move = useCallback(
    (from: number, to: number) => {
      if (from === to) return;
      void run(() => ({ change: { op: 'move', slide: from + 1, to: to + 1 }, at: to }));
    },
    [run],
  );

  return { add, remove, move, busy };
}
