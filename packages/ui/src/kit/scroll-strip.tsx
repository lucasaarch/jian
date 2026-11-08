'use client';

import { type CSSProperties, type HTMLAttributes, useEffect, useLayoutEffect, useRef } from 'react';
import { watchSize } from '../lib/watch-size';

/**
 * How wide an edge fades, in px, and how far a revealed item is kept from it. Given to the
 * `scroll-strip` utility as `--strip-fade`, so the two cannot disagree.
 */
const FADE = 24;
/** A wheel's line, in px, for a mouse that counts in lines rather than pixels. */
const LINE = 16;

/** Marks each edge with more past it, for its fade. */
function markEdges(element: HTMLElement) {
  const more = element.scrollWidth - element.clientWidth;
  element.toggleAttribute('data-more-start', more > 0 && element.scrollLeft > 0);
  // A fractional width can leave the end a pixel short of the last one.
  element.toggleAttribute('data-more-end', more > 0 && element.scrollLeft < more - 1);
}

/** Where the strip scrolls so an item shows whole, clear of the fades; unchanged if it does. */
function revealedAt(
  strip: { left: number; width: number; scrollLeft: number },
  item: { left: number; width: number },
) {
  const start = strip.scrollLeft + item.left - strip.left;
  const end = start + item.width;
  if (start - FADE < strip.scrollLeft) return Math.max(0, start - FADE);
  if (end + FADE > strip.scrollLeft + strip.width) return end + FADE - strip.width;
  return strip.scrollLeft;
}

/**
 * A row of items that scrolls sideways with no scrollbar, as tabs do: a vertical wheel scrolls it
 * while it overflows, an edge with more past it fades, and the item marked `aria-selected="true"`
 * is brought into view whenever `active` names another. Draws the `scroll-strip` utility.
 */
export function ScrollStrip({
  active,
  className = '',
  style,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  /** What is selected; a change brings it into view. */
  active?: string;
}) {
  const strip = useRef<HTMLDivElement>(null);

  // The fades follow the scroll and the size, written on the element: a render per scrolled
  // pixel would redraw every item for two attributes.
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const mark = () => markEdges(element);
    // Mapped by hand: a wheel that only moves vertically does nothing to a row. Not passive, so
    // the page under it does not scroll too.
    const wheel = (event: WheelEvent) => {
      // A held modifier zooms the page or means something else to the host: never the row's.
      if (event.ctrlKey || event.metaKey) return;
      const more = element.scrollWidth - element.clientWidth;
      if (more <= 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      // At the end it was turned towards, the wheel is left to what is under the row.
      if (event.deltaY > 0 ? element.scrollLeft >= more - 1 : element.scrollLeft <= 0) return;
      event.preventDefault();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? LINE
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? element.clientWidth
            : 1;
      element.scrollLeft += event.deltaY * unit;
      mark();
    };
    mark();
    element.addEventListener('scroll', mark, { passive: true });
    element.addEventListener('wheel', wheel, { passive: false });
    const unwatch = watchSize(mark, element);
    return () => {
      element.removeEventListener('scroll', mark);
      element.removeEventListener('wheel', wheel);
      unwatch();
    };
  }, []);

  // Items come and go without the strip changing size: the fades are checked after each render.
  useLayoutEffect(() => {
    if (strip.current) markEdges(strip.current);
  });

  // Set by hand rather than with scrollIntoView, which would also scroll every scrolling
  // ancestor, the window's among them, to bring the item level.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `active` is what asks for this.
  useLayoutEffect(() => {
    const element = strip.current;
    const selected = element?.querySelector('[aria-selected="true"]');
    if (!element || !selected) return;
    let item: Element = selected;
    while (item.parentElement && item.parentElement !== element) item = item.parentElement;
    const view = element.getBoundingClientRect();
    const box = item.getBoundingClientRect();
    const next = revealedAt(
      { left: view.left, width: view.width, scrollLeft: element.scrollLeft },
      { left: box.left, width: box.width },
    );
    if (next === element.scrollLeft) return;
    element.scrollLeft = next;
    markEdges(element);
  }, [active]);

  return (
    <div
      ref={strip}
      className={`scroll-strip ${className}`}
      style={{ '--strip-fade': `${FADE}px`, ...style } as CSSProperties}
      {...props}
    >
      {children}
    </div>
  );
}
