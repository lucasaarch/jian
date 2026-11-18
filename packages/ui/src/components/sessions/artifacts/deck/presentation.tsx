'use client';

import { ARTIFACT_PRESENT_MESSAGE } from '@jian/contracts';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArtifactFrame } from '../artifact-frame';

/**
 * A deck presented, in the player its public link runs (the gateway's player.ts), so the two are
 * one experience: fullscreen, the arrows, Space and the page keys, a click to move on, the same
 * transitions and controls. The panel draws none of it. It makes a black layer over the window,
 * asks the browser to take the whole screen for that layer, and puts the player's sealed frame in
 * it (artifact-frame.tsx), handed the deck and the slide to start on.
 *
 * Fullscreen is the panel's to ask for, from the click on Present; the frame is not given leave
 * to. Where it is refused, the layer covers the window all the same.
 *
 * The player says `end` when its reader presses Escape or its end button, which is read from the
 * frame this layer holds and nothing else. The browser's own Escape leaves the whole screen
 * without a key reaching any page, which is read here as the end as well.
 */
export function Presentation({
  title,
  source,
  start,
  onClose,
}: {
  title: string;
  /** The deck as a version keeps it: its slides, in JSON. */
  source: string;
  /** The slide to start on, counted from 0. */
  start: number;
  onClose: () => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [handed] = useState(() => JSON.stringify({ ...JSON.parse(source), start }));
  // Read when the end comes, so a parent drawn again does not end it twice.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const element = layer.current;
    let entered = false;
    const left = () => {
      if (entered && !document.fullscreenElement) close.current();
    };
    const said = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null;
      if (
        event.source === frame.current?.contentWindow &&
        data?.[ARTIFACT_PRESENT_MESSAGE] === 'end'
      ) {
        close.current();
      }
    };
    // An Escape that reaches the document closes the Inspector (useDrawerFocus). Here it ends the
    // presentation and goes no further.
    const escaped = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close.current();
    };

    element?.requestFullscreen?.().then(
      () => {
        entered = true;
      },
      // Refused, as where the page may not take the screen: it covers the window all the same.
      () => undefined,
    );
    frame.current?.focus();
    document.addEventListener('fullscreenchange', left);
    addEventListener('message', said);
    addEventListener('keydown', escaped, true);

    return () => {
      document.removeEventListener('fullscreenchange', left);
      removeEventListener('message', said);
      removeEventListener('keydown', escaped, true);
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  return createPortal(
    <div
      ref={layer}
      role="dialog"
      aria-label={`${title}, presented`}
      className="fixed inset-0 z-50 bg-black"
    >
      <ArtifactFrame
        type="deck"
        title={`${title}, presented`}
        source={handed}
        presenting
        frame={frame}
        className="size-full border-0"
      />
    </div>,
    document.body,
  );
}
