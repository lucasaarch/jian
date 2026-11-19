'use client';

import { useQueryClient } from '@tanstack/react-query';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { SessionArtifact } from '../../../lib/api';
import { keys } from '../../../lib/query/keys';
import { collectEdit, editChanged } from './edit';
import { type ArtifactsApi, artifactChanged } from './use-artifacts';

export type SaveState = 'idle' | 'saving' | 'saved' | 'retrying';

/** How long the owner stops typing before what they wrote is kept. */
const IDLE = 1500;
/** How long a save that failed waits before it is tried again, with no one asked. */
const RETRY = 4000;

/**
 * Keeps what the owner edits by hand, with no Save to press. The editing frame says that
 * something changed (edit.ts); a second and a half later, or when the owner leaves, the source
 * is asked of the frame and handed to the gateway.
 *
 * One stretch of editing is one version: every save carries the same `editKey`, and the gateway
 * writes the owner's version of that stretch over itself, never over the agent's. A stretch ends
 * with `end`, which the caller calls before it shows anything else, and starts anew after.
 */
export function useAutosave({
  api,
  profileId,
  artifact,
  frame,
  base,
  slide,
  active,
  touched,
}: {
  api: ArtifactsApi;
  profileId: string;
  artifact: SessionArtifact;
  frame: RefObject<HTMLIFrameElement | null>;
  /** The version the frame was opened on: what the first save of a stretch is made from. */
  base: number;
  /** A deck's slide in view, counted from 0; the frame holds only that one. */
  slide: number | undefined;
  /** Whether a frame is open for editing; the panel hears nothing from a frame that is not. */
  active: boolean;
  /** Told when the first change of a stretch is heard, so the caller can hold the version. */
  touched: () => void;
}) {
  const client = useQueryClient();
  const [state, setState] = useState<SaveState>('idle');
  const stretch = useRef(crypto.randomUUID());
  // The owner's version of this stretch, once one was saved.
  const saved = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const running = useRef<Promise<boolean>>(Promise.resolve(true));
  const latest = useRef({ api, profileId, artifact, base, slide, touched });
  latest.current = { api, profileId, artifact, base, slide, touched };

  const arm = useCallback((wait: number, run: () => void) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(run, wait);
  }, []);

  // Saves in turn, never two at once: the second would be made from what the first changes.
  const save = useCallback((): Promise<boolean> => {
    clearTimeout(timer.current);
    const turn = running.current.then(async () => {
      if (!dirty.current) return true;
      dirty.current = false;
      setState('saving');
      const now = latest.current;
      try {
        const html = await collectEdit(frame.current);
        if (html === null) {
          setState('idle');
          return true;
        }
        const next = await now.api.editSessionArtifact(
          now.profileId,
          now.artifact.sessionId,
          now.artifact.id,
          {
            version: saved.current ?? now.base,
            content: html,
            editKey: stretch.current,
            ...(now.slide === undefined ? {} : { slide: now.slide + 1 }),
          },
        );
        // The version this should have been: the same one again within a stretch, or the one
        // after the latest the panel knew. Anything else is the agent having written meanwhile.
        const expected = saved.current ?? now.artifact.version + 1;
        saved.current = next.version;
        artifactChanged(client, now.profileId, next);
        // A version written over is stale wherever it was read before.
        void client.invalidateQueries({
          queryKey: keys.sessionArtifacts(now.profileId, next.sessionId, next.id, next.version),
          exact: true,
          refetchType: 'none',
        });
        if (next.version !== expected) {
          toast(
            `The agent wrote a newer version meanwhile. Your edit is saved on top, as version ${next.version}.`,
          );
        }
        setState('saved');
        return true;
      } catch {
        // Nothing typed is lost: it is tried again, and the frame keeps what was written.
        dirty.current = true;
        setState('retrying');
        arm(RETRY, () => void save());
        return false;
      }
    });
    running.current = turn;

    return turn;
  }, [client, frame, arm]);

  useEffect(() => {
    if (!active) return;
    const hear = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target || !editChanged(event.data)) return;
      if (!dirty.current && saved.current === undefined) latest.current.touched();
      dirty.current = true;
      arm(IDLE, () => void save());
    };
    const leaving = () => {
      if (document.visibilityState === 'hidden' && dirty.current) void save();
    };
    const closing = () => {
      if (dirty.current) void save();
    };
    window.addEventListener('message', hear);
    document.addEventListener('visibilitychange', leaving);
    window.addEventListener('pagehide', closing);

    return () => {
      window.removeEventListener('message', hear);
      document.removeEventListener('visibilitychange', leaving);
      window.removeEventListener('pagehide', closing);
      clearTimeout(timer.current);
    };
  }, [active, frame, arm, save]);

  /**
   * Keeps what is pending and closes the stretch. False when it could not be kept, in which case
   * the caller stays where it is: leaving would lose what was typed.
   */
  const end = useCallback(async (): Promise<boolean> => {
    const kept = await save();
    if (!kept) {
      toast.error('Your edit is not saved yet. It will be tried again.');
      return false;
    }
    stretch.current = crypto.randomUUID();
    saved.current = undefined;
    setState('idle');

    return true;
  }, [save]);

  return { state, end };
}
