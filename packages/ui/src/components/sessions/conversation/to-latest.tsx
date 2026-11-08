'use client';

import { ArrowDown } from 'lucide-react';
import { memo, type RefObject, useEffect, useState } from 'react';
import { Action } from '../../../kit';
import { useAppearance } from '../../../lib/appearance';
import { watchSize } from '../../../lib/watch-size';
import { FOLLOW_WITHIN_PX } from '../follow-bottom';

/** How far the end of the conversation is below what the reader sees, in px. */
const below = (view: HTMLElement) => view.scrollHeight - view.scrollTop - view.clientHeight;
/** A row's height in px; what is not an element of the page has none. */
const heightOf = (row: Element | null) => (row instanceof HTMLElement ? row.offsetHeight : 0);
/**
 * Less than this below the end, in px, is the end: a zoomed or high-density screen scrolls by
 * fractions of a pixel and may stop just short of it.
 */
const AT_END_PX = 1;

/**
 * The way back to the end of a long conversation, over its bottom edge. It shows as soon as the
 * reader leaves the end, however little, and its dot says something arrived below where the
 * history no longer follows them. It
 * listens to the scroll and sizes itself, so the history around it never draws for them.
 */
export const ToLatest = memo(function ToLatest({
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
    let tail = content.lastElementChild;
    let tailHeight = heightOf(tail);
    const measure = () => {
      last = below(view);
      setAway(last > AT_END_PX);
      if (last < FOLLOW_WITHIN_PX) setFresh(false);
    };
    // News is only what lands at the end: a new last row, or the last one growing, as an answer
    // being written does. Growth anywhere else is the conversation changing in place: earlier
    // pages above, a tool opened or an image loaded around the reader, the view itself resized.
    // A change of width rewraps every row, the last one too.
    const resized = () => {
      const rewrapped = content.clientWidth !== width;
      const now = content.lastElementChild;
      const news = now !== tail ? Boolean(now) : heightOf(now) > tailHeight;
      width = content.clientWidth;
      tail = now;
      tailHeight = heightOf(now);
      // Within FOLLOW_WITHIN_PX the history follows the reader to the news: nothing is missed.
      if (news && !rewrapped && last >= FOLLOW_WITHIN_PX) setFresh(true);
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
        aria-label={
          fresh ? 'Go to the latest message, new messages below' : 'Go to the latest message'
        }
        aria-hidden={away ? undefined : true}
        inert={!away}
        onClick={(event) => {
          // The button goes inert as the reader arrives: the keyboard's place moves to the
          // history it brought them to, instead of falling to the page.
          const focused = document.activeElement === event.currentTarget;
          toEnd(!still);
          if (focused) scroller.current?.focus({ preventScroll: true });
        }}
      >
        <ArrowDown size={16} aria-hidden="true" />
        {fresh && <span className="to-latest-dot" aria-hidden="true" />}
      </Action>
    </div>
  );
});
