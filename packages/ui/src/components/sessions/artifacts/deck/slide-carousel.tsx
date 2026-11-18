'use client';

import {
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import { useAppearance } from '../../../../lib/appearance';
import { watchSize } from '../../../../lib/watch-size';
import { SlideFrame } from './slide-frame';

/** How far a wheel turns, in px, before it is a step to the next slide. */
const TURN = 20;
/** A wheel's line, in px, for a mouse that counts in lines rather than pixels. */
const LINE = 16;
/** A wheel quiet for this long, in ms, has ended its turn: the next event starts another. */
const PAUSE = 150;
/** A wheel still turning this long, in ms, after a step takes another. */
const AGAIN = 700;
/** How far the pointer moves, in px, before a press is a drag. */
const DRAG = 4;
/** The share of the width a drag covers before letting go moves to the next slide. */
const PULL = 0.15;
/** How long a move to a slide is waited for, in ms, before it is put there outright. */
const SETTLE = 1000;

/**
 * How far apart two slides stand in the track, in px. Not the track's width, which the browser
 * rounds: over many slides the halves of a pixel add up to a place between two.
 */
const pitch = (element: HTMLElement) => element.scrollWidth / Math.max(1, element.children.length);

/**
 * The slides of a deck side by side, one filling the view, the one in view centred: it is
 * dragged, swiped or scrolled sideways to the next, and comes to rest on a slide, never between
 * two. A wheel that only turns vertically steps a slide at a time. What it rests on is told to
 * `onAt`, and `at` changing from outside (the row of small ones, the arrows, a key) moves it.
 *
 * - A slide here is looked at, not used: it takes no pointer, so a drag or a wheel over it
 *   reaches the track instead of a frame the panel cannot hear. The one open for editing is the
 *   exception, and while it is open the track does not move.
 * - Only the slide in view and the ones beside it are drawn; the rest keep their place empty.
 * - The scroll's position is the browser's, not React's: nothing renders per pixel scrolled.
 */
export function SlideCarousel({
  title,
  slides,
  at,
  onAt,
  editing,
  frame,
}: {
  title: string;
  slides: readonly string[];
  /** The slide in view, counted from 0. */
  at: number;
  onAt: (index: number) => void;
  editing: boolean;
  /** The frame of the slide in view, for the one who saves an edit. */
  frame: RefObject<HTMLIFrameElement | null>;
}) {
  const { still } = useAppearance();
  const track = useRef<HTMLDivElement>(null);
  // Read by listeners that outlive a render.
  const live = useRef({ at, onAt, editing, last: slides.length - 1 });
  live.current = { at, onAt, editing, last: slides.length - 1 };
  // The slide a move of this component's own is on its way to. Until it arrives, the positions
  // the scroll passes through are not the owner's choice and are told to no one.
  const aim = useRef<number | undefined>(undefined);
  const settling = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The slide the track rests on, or is moving to: `at` naming it asks for no move.
  const seen = useRef<number | undefined>(undefined);
  // The width the track was last aligned for. A scroll at another width is the browser fitting
  // a resize, which says nothing about the slide in view.
  const sized = useRef(0);
  const drag = useRef<{ pointer: number; x: number; left: number; moved: boolean } | undefined>(
    undefined,
  );

  const settle = useCallback(() => {
    aim.current = undefined;
    clearTimeout(settling.current);
    // Snapping was off for a drag and the move that ended it.
    if (!drag.current) track.current?.style.removeProperty('scroll-snap-type');
  }, []);

  const moveTo = useCallback(
    (index: number, smooth: boolean) => {
      const element = track.current;
      // With no width yet, as in a tab not shown, it is aligned when it gets one.
      if (!element?.clientWidth) return;
      const left = index * pitch(element);
      seen.current = index;
      sized.current = element.clientWidth;
      if (Math.abs(element.scrollLeft - left) < 1) return settle();
      aim.current = index;
      element.scrollTo({ left, behavior: smooth ? 'smooth' : 'instant' });
      clearTimeout(settling.current);
      // A browser that never gets there, or gets there a pixel off, is not waited on for ever.
      settling.current = setTimeout(() => {
        settle();
        element.scrollLeft = index * pitch(element);
      }, SETTLE);
    },
    [settle],
  );

  useLayoutEffect(() => {
    if (seen.current === at) return;
    // Where it starts is simply where it is; after that it is seen to move.
    moveTo(at, seen.current !== undefined && !still);
  }, [at, still, moveTo]);

  useEffect(() => {
    const element = track.current;
    if (!element) return;
    let turned = 0;
    let before = 0;
    let stepped = 0;
    // Mapped by hand: a wheel that only moves vertically does nothing to a row. Not passive, so
    // nothing under it scrolls too. Sideways is the track's own scroll, left to the browser.
    const wheel = (event: WheelEvent) => {
      const { at, onAt, editing, last } = live.current;
      // A held modifier zooms the page or means something else to the host: never the deck's.
      if (event.ctrlKey || event.metaKey || editing) return;
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
        // The owner's hand on the track ends a move of this component's own.
        if (event.deltaX !== 0) settle();
        return;
      }
      event.preventDefault();
      if (event.timeStamp - before > PAUSE) {
        turned = 0;
        stepped = 0;
      }
      before = event.timeStamp;
      // One step a turn: a trackpad goes on sending the same swipe long after the fingers left.
      if (stepped && event.timeStamp - stepped < AGAIN) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? LINE
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? element.clientWidth
            : 1;
      turned += event.deltaY * unit;
      if (Math.abs(turned) < TURN) return;
      const to = Math.max(0, Math.min(last, at + Math.sign(turned)));
      turned = 0;
      stepped = event.timeStamp;
      if (to !== at) onAt(to);
    };
    const align = () => {
      if (element.clientWidth === sized.current) return;
      sized.current = element.clientWidth;
      if (!drag.current) moveTo(live.current.at, false);
    };

    element.addEventListener('wheel', wheel, { passive: false });
    const unwatch = watchSize(align, element);
    return () => {
      element.removeEventListener('wheel', wheel);
      unwatch();
      clearTimeout(settling.current);
    };
  }, [moveTo, settle]);

  const scrolled = () => {
    const element = track.current;
    const width = element?.clientWidth;
    if (!element || !width || width !== sized.current || drag.current?.moved) return;
    const apart = pitch(element);
    if (aim.current !== undefined) {
      if (Math.abs(element.scrollLeft - aim.current * apart) < 1) settle();
      return;
    }
    const index = Math.max(0, Math.min(slides.length - 1, Math.round(element.scrollLeft / apart)));
    if (index === at) return;
    seen.current = index;
    onAt(index);
  };

  // A mouse drags it; a finger and a trackpad scroll it themselves.
  const pressed = (event: PointerEvent<HTMLDivElement>) => {
    // The owner's hand on the track ends a move of this component's own.
    settle();
    if (event.pointerType !== 'mouse' || event.button !== 0 || editing || slides.length < 2) return;
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX,
      left: event.currentTarget.scrollLeft,
      moved: false,
    };
  };
  const dragged = (event: PointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (held?.pointer !== event.pointerId) return;
    const by = event.clientX - held.x;
    if (!held.moved) {
      if (Math.abs(by) < DRAG) return;
      held.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      // It follows the hand: snapping would pull it back at every move.
      event.currentTarget.style.scrollSnapType = 'none';
      event.currentTarget.toggleAttribute('data-dragging', true);
    }
    event.currentTarget.scrollLeft = held.left - by;
  };
  const released = (event: PointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (held?.pointer !== event.pointerId) return;
    drag.current = undefined;
    if (!held.moved) return;
    const element = event.currentTarget;
    element.toggleAttribute('data-dragging', false);
    // A drag the browser took away goes back to where it started.
    const by = event.type === 'pointercancel' ? 0 : event.clientX - held.x;
    const from = Math.round(held.left / pitch(element));
    const far = Math.abs(by) > element.clientWidth * PULL;
    const to = Math.max(0, Math.min(slides.length - 1, from + (far ? -Math.sign(by) : 0)));
    moveTo(to, !still);
    if (to !== at) onAt(to);
  };

  return (
    <div
      ref={track}
      // The track itself is no control: the slide in view is told by the count below it, and
      // every way of moving it has a button or a key of its own (deck-view.tsx).
      className={`scroll-strip flex min-h-0 flex-1 snap-x snap-mandatory overflow-y-hidden select-none ${slides.length > 1 && !editing ? 'cursor-grab data-dragging:cursor-grabbing' : ''}`}
      // Open for editing, the slide stays put under the owner's hands.
      style={editing ? { overflowX: 'hidden' } : undefined}
      onScroll={scrolled}
      onPointerDown={pressed}
      onPointerMove={dragged}
      onPointerUp={released}
      onPointerCancel={released}
    >
      {slides.map((slide, index) => {
        const open = editing && index === at;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a slide has no name but its place.
            key={index}
            data-current={index === at ? '' : undefined}
            inert={index !== at}
            className={`relative w-full shrink-0 snap-center snap-always ${open ? '' : 'pointer-events-none'}`}
          >
            {Math.abs(index - at) <= 1 && (
              <SlideFrame
                key={String(open)}
                title={`${title}, slide ${index + 1}`}
                source={slide}
                editing={open}
                {...(open ? { frame } : {})}
                className="absolute inset-0 px-(--inspector-inset) py-2"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
