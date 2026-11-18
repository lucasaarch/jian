'use client';

import { Dialog } from '@base-ui/react/dialog';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { iconButton } from '../../../../kit';
import { SlideFrame } from './slide-frame';

/** The keys that step through a presentation, and how far each goes. */
const STEP: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  PageDown: 1,
  ' ': 1,
  Enter: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  PageUp: -1,
  Backspace: -1,
};

/**
 * A deck presented: one slide filling the screen, on black. It asks the browser for the whole
 * screen and, where that is refused, covers the window instead. The keys and a click step
 * through it, and Escape ends it. A slide fades in over the one before it, which stays drawn
 * under it, so there is no black between two; whoever asked for less motion gets the next slide
 * at once (flight.css).
 *
 * The slide is inert here: a click on it is the click that moves on, and the keyboard stays with
 * the presentation instead of going into a frame the panel cannot hear.
 */
export function Presentation({
  title,
  slides,
  at,
  onAt,
  onClose,
}: {
  title: string;
  slides: readonly string[];
  at: number;
  onAt: (index: number) => void;
  onClose: () => void;
}) {
  const stage = useRef<HTMLDivElement | null>(null);
  // The portal draws the stage a render after this one: the screen is asked for once the stage
  // is there, which an effect of the first render alone never sees.
  const [drawn, setDrawn] = useState<HTMLDivElement | null>(null);
  const hold = useCallback((element: HTMLDivElement | null) => {
    stage.current = element;
    setDrawn(element);
  }, []);
  // Read when the screen is left, so a parent drawn again does not leave and take it twice.
  const close = useRef(onClose);
  close.current = onClose;
  const last = slides.length - 1;
  // The slide left for this one, kept drawn under it, and how many times a slide was left:
  // each one shown is a layer of its own, named by that count, so a frame is never moved or
  // handed another slide, either of which would leave it empty.
  const [left, setLeft] = useState<{ turn: number; slide?: number }>({ turn: 0 });
  const go = (to: number) => {
    const target = Math.max(0, Math.min(last, to));
    if (target === at) return;
    setLeft({ turn: left.turn + 1, slide: at });
    onAt(target);
  };
  const layers = [
    ...(left.slide === undefined ? [] : [{ turn: left.turn - 1, slide: left.slide }]),
    { turn: left.turn, slide: at },
  ];

  useEffect(() => {
    const element = drawn;
    if (!element?.requestFullscreen) return;
    let entered = false;
    const left = () => {
      // The browser's own Escape leaves the whole screen without a key reaching the page.
      if (entered && !document.fullscreenElement) close.current();
    };

    element.requestFullscreen().then(
      () => {
        entered = true;
      },
      // Refused, as where the page may not take the screen: it covers the window all the same.
      () => undefined,
    );
    document.addEventListener('fullscreenchange', left);
    return () => {
      document.removeEventListener('fullscreenchange', left);
      if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    };
  }, [drawn]);

  const keyed = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      // An Escape that reaches the document closes the Inspector (useDrawerFocus). This one ends
      // the presentation and goes no further.
      event.nativeEvent.stopPropagation();
      onClose();
      return;
    }
    const by = STEP[event.key];
    if (by === undefined && event.key !== 'Home' && event.key !== 'End') return;
    // Space and Enter on one of its buttons press that button.
    const presses = event.key === ' ' || event.key === 'Enter';
    if (presses && (event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    // A portal's events still reach the deck that opened it, which has keys of its own.
    event.stopPropagation();
    go(by === undefined ? (event.key === 'Home' ? 0 : last) : at + by);
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Popup
          ref={hold}
          initialFocus={stage}
          aria-label={`${title}, presented`}
          onKeyDown={keyed}
          className="group/present fixed inset-0 z-50 bg-black outline-none"
        >
          {layers.map(({ turn, slide }) => (
            <div
              key={turn}
              inert
              className="absolute inset-0 grid animate-[viewer-fade_320ms_ease-out]"
            >
              <SlideFrame
                key={slide}
                title={`Slide ${slide + 1} of ${slides.length}`}
                source={slides[slide] ?? ''}
                className="size-full"
              />
            </div>
          ))}
          {/* The whole screen moves on at a click. The keyboard has its keys and the buttons
              below, so this one is the pointer's alone. */}
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="absolute inset-0 cursor-default outline-none"
            onClick={() => go(at + 1)}
          />
          {/* Out of the slide's way until the pointer or the keyboard comes for it. */}
          <div className="absolute inset-x-0 bottom-0 flex justify-center pb-4 opacity-0 transition-opacity duration-200 focus-within:opacity-100 hover:opacity-100">
            <div className="glass flex items-center gap-0.5 rounded-full p-1 text-xs text-ink">
              <button
                type="button"
                aria-label="Previous slide"
                disabled={at === 0}
                className={iconButton}
                onClick={() => go(at - 1)}
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <span className="min-w-12 text-center tabular-nums" aria-live="polite">
                {at + 1} / {slides.length}
              </span>
              <button
                type="button"
                aria-label="Next slide"
                disabled={at === last}
                className={iconButton}
                onClick={() => go(at + 1)}
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
              <Dialog.Close aria-label="End presentation" className={iconButton}>
                <X size={16} aria-hidden="true" />
              </Dialog.Close>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
