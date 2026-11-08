'use client';

import { ArrowDown } from 'lucide-react';
import { type RefObject, useEffect, useState } from 'react';
import { Action } from '../../../kit';
import { useAppearance } from '../../../lib/appearance';
import { watchSize } from '../../../lib/watch-size';
import { FOLLOW_WITHIN_PX } from '../follow-bottom';

/** How far the end of the conversation is below what the reader sees, in px. */
const below = (view: HTMLElement) => view.scrollHeight - view.scrollTop - view.clientHeight;

/**
 * The way back to the end of a long conversation, over its bottom edge. It shows only to a reader
 * a screen or more from the end, and its dot says something arrived down there meanwhile. It
 * listens to the scroll and sizes itself, so the history around it never draws for them.
 */
export function ToLatest({
  scroller,
  toEnd,
}: {
  scroller: RefObject<HTMLElement | null>;
  toEnd: (smooth: boolean) => void;
}) {
  const { still } = useAppearance();
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(false);

  useEffect(() => {
    const view = scroller.current;
    const content = view?.firstElementChild;
    if (!view || !content) return;
    let last = below(view);
    let width = content.clientWidth;
    const measure = () => {
      last = below(view);
      setAway(last > view.clientHeight);
      if (last < FOLLOW_WITHIN_PX) setFresh(false);
    };
    // Only growth under a reader already away is news. Earlier pages land above them and keep
    // the distance (earlier.tsx holds their place), and a change of width rewraps everything.
    const resized = () => {
      const rewrapped = content.clientWidth !== width;
      width = content.clientWidth;
      if (!rewrapped && last > view.clientHeight && below(view) > last + 1) setFresh(true);
      measure();
    };
    view.addEventListener('scroll', measure, { passive: true });
    const unwatch = watchSize(resized, content, view);
    measure();

    return () => {
      view.removeEventListener('scroll', measure);
      unwatch();
    };
  }, [scroller]);

  // Kept on the page while hidden, so it can fade out; out of reach of the keyboard and the
  // screen reader meanwhile.
  return (
    <div className="to-latest" data-shown={away || undefined}>
      <Action
        tone="glass"
        size="icon"
        aria-label="Go to the latest message"
        aria-hidden={away ? undefined : true}
        inert={!away}
        onClick={() => toEnd(!still)}
      >
        <ArrowDown size={16} aria-hidden="true" />
        {fresh && <span className="to-latest-dot" aria-hidden="true" />}
      </Action>
    </div>
  );
}
