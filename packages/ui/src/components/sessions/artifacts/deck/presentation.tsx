'use client';

import { Dialog } from '@base-ui/react/dialog';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef } from 'react';
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
 * through it, and Escape ends it.
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
  const stage = useRef<HTMLDivElement>(null);
  // Read when the screen is left, so a parent drawn again does not leave and take it twice.
  const close = useRef(onClose);
  close.current = onClose;
  const last = slides.length - 1;
  const go = (to: number) => onAt(Math.max(0, Math.min(last, to)));

  useEffect(() => {
    const element = stage.current;
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
  }, []);

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
          ref={stage}
          initialFocus={stage}
          aria-label={`${title}, presented`}
          onKeyDown={keyed}
          className="group/present fixed inset-0 z-50 bg-black outline-none"
        >
          <div inert className="absolute inset-0 grid">
            <SlideFrame
              key={at}
              title={`Slide ${at + 1} of ${slides.length}`}
              source={slides[at] ?? ''}
              className="size-full"
            />
          </div>
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
