'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** Something in the conversation, and how far below the top of the view it sat. */
type Anchor = { element: Element; offset: number };

/** A reader this near the end, in px, is at it: the history follows them again. */
export const FOLLOW_WITHIN_PX = 80;
/**
 * The longest a smooth scroll to the end is waited on, in ms. A browser may end it without the
 * scroll event that says it landed; the history then follows only if it left the reader there.
 */
const GLIDE_MS = 1000;
/** What a reader does to take the scroll back from a glide, before or without a scroll. */
const TAKEN = ['wheel', 'touchstart', 'pointerdown'] as const;

const nearEnd = (view: HTMLElement) =>
  view.scrollHeight - view.scrollTop - view.clientHeight < FOLLOW_WITHIN_PX;

/**
 * Chats open at the end and follow new content until the reader scrolls up.
 *
 * A reader who has scrolled up keeps their place when the conversation changes width, as it
 * does when the drawer beside it opens: the text rewraps, everything above grows or shrinks,
 * and the same scroll offset would show another part of the conversation. The browser's own
 * scroll anchoring would do this, but Safari has none, so the history keeps its own anchor:
 * what was at the top of the view, or what the reader acted on, held at the same height.
 */
export function useFollowBottom() {
  const scroller = useRef<HTMLElement>(null);
  const following = useRef(true);
  const anchor = useRef<Anchor>(undefined);
  // Between a hold and the change of width it expects, the browser clamps the scroll as the
  // content shrinks and reports it as a scroll; that is not the reader moving, and must not
  // replace the anchor or make the history follow the end.
  const holding = useRef(false);
  // A smooth scroll to the end passes through the conversation, reporting scrolls that are not
  // the reader leaving it: until it lands, the history keeps following. A reader who scrolls
  // back up, or reaches for the wheel or the screen, ends it at once, where they are.
  const gliding = useRef(false);
  const glide = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Where the last scroll left the view, in px, to tell a reader going up from the glide.
  const lastTop = useRef(0);

  const place = useCallback((element: Element): Anchor | undefined => {
    const view = scroller.current;
    if (!view) return undefined;

    return {
      element,
      offset: element.getBoundingClientRect().top - view.getBoundingClientRect().top,
    };
  }, []);

  /** The first item of the conversation still in view, which is what a reader is reading. */
  const topmost = useCallback(() => {
    const view = scroller.current;
    const content = view?.firstElementChild;
    if (!view || !content) return undefined;
    const top = view.getBoundingClientRect().top;

    return [...content.children].find((item) => item.getBoundingClientRect().bottom > top);
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    const content = element?.firstElementChild;
    if (!element || !content) return;
    let width = content.clientWidth;
    const follow = () => {
      const rewrapped = content.clientWidth !== width;
      width = content.clientWidth;

      if (rewrapped) holding.current = false;
      if (following.current) {
        element.scrollTop = element.scrollHeight;
        return;
      }
      // Only a change of width moves what is above the reader; new messages land below.
      const held = anchor.current;
      if (rewrapped && held?.element.isConnected) {
        const now = place(held.element)?.offset ?? held.offset;
        element.scrollTop += now - held.offset;
      }
    };
    const observer = new ResizeObserver(follow);
    follow();
    observer.observe(content);
    return () => observer.disconnect();
  }, [place]);

  /** The glide is over: the history follows from here only if the reader is at the end. */
  const land = useCallback(() => {
    const view = scroller.current;
    clearTimeout(glide.current);
    if (!gliding.current || !view) return;
    gliding.current = false;
    following.current = nearEnd(view);
  }, []);
  useEffect(() => {
    const view = scroller.current;
    if (!view) return;
    for (const kind of TAKEN) view.addEventListener(kind, land, { passive: true });
    return () => {
      for (const kind of TAKEN) view.removeEventListener(kind, land);
      clearTimeout(glide.current);
    };
  }, [land]);

  const follow = useCallback(() => {
    following.current = true;
  }, []);
  /** Back to the end, gliding unless motion is reduced, and following from there. */
  const toEnd = useCallback(
    (smooth: boolean) => {
      const view = scroller.current;
      if (!view) return;
      following.current = true;
      gliding.current = smooth;
      lastTop.current = view.scrollTop;
      clearTimeout(glide.current);
      if (smooth) glide.current = setTimeout(land, GLIDE_MS);
      view.scrollTo({ top: view.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    },
    [land],
  );
  const onScroll = useCallback(
    (element: HTMLElement) => {
      const up = element.scrollTop < lastTop.current;
      lastTop.current = element.scrollTop;
      if (holding.current) return;
      const near = nearEnd(element);
      if (gliding.current) {
        if (!near && !up) return;
        gliding.current = false;
        clearTimeout(glide.current);
      }
      following.current = near;
      const top = topmost();
      anchor.current = top ? place(top) : undefined;
    },
    [place, topmost],
  );
  /**
   * Holds this element where it is through the next change of width, or what is at the top of
   * the view when it is not in the conversation. Called just before the layout changes.
   */
  const hold = useCallback(
    (element?: Element | null) => {
      // A reader at the end stays at the end; anyone else keeps what they were looking at.
      if (following.current) return;
      const inside = element && scroller.current?.contains(element) ? element : topmost();
      anchor.current = inside ? place(inside) : undefined;
      holding.current = Boolean(anchor.current);
      // A pane wide enough for its column does not rewrap at all: nothing would end the hold.
      window.setTimeout(() => {
        holding.current = false;
      }, 400);
    },
    [place, topmost],
  );

  return {
    scroller,
    follow,
    toEnd,
    onScroll,
    hold,
  };
}
