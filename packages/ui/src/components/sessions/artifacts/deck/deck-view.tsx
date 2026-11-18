'use client';

import { ChevronLeft, ChevronRight, Presentation as PresentIcon } from 'lucide-react';
import { type KeyboardEvent, type RefObject, useState } from 'react';
import { HoverTip, iconButton } from '../../../../kit';
import { Presentation } from './presentation';
import { SlideFrame } from './slide-frame';

/**
 * A deck in the Inspector: its slides numbered down the side, each drawn small, and the one in
 * view large beside them, with the way to step through and to present. Mount it with a key per
 * version, so a new version's slides are new frames.
 *
 * While the owner edits, it is the slide in view that is open for editing, and it stays in
 * view: moving to another would drop what was typed, so the rail and the steps wait for Save
 * or Cancel.
 */
export function DeckView({
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
  const [presenting, setPresenting] = useState(false);
  const last = slides.length - 1;

  const keyed = (event: KeyboardEvent) => {
    const by = { ArrowLeft: -1, PageUp: -1, ArrowRight: 1, PageDown: 1 }[event.key];
    if (!by || editing) return;
    const to = at + by;
    if (to < 0 || to > last) return;
    event.preventDefault();
    onAt(to);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the arrows step from any of its buttons.
    <div className="flex min-h-0 flex-1" onKeyDown={keyed}>
      <nav
        aria-label="Slides"
        className="scroll-inset w-28 shrink-0 overflow-y-auto py-2 pr-1 pl-(--inspector-inset)"
      >
        <ol className="grid grid-cols-1 gap-2">
          {slides.map((slide, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a slide has no name but its place.
            <li key={index} className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-1.5">
              <span className="pt-0.5 text-right text-[11px] text-muted tabular-nums">
                {index + 1}
              </span>
              <div
                className={`relative aspect-video overflow-hidden rounded-md ring-1 transition-shadow ${index === at ? 'ring-2 ring-accent' : 'ring-glass-edge'}`}
              >
                {/* Looked at, not used: the button over it is what a click and a key reach. */}
                <div inert className="absolute inset-0 grid">
                  <SlideFrame
                    title={`Slide ${index + 1}, small`}
                    source={slide}
                    lazy
                    className="size-full"
                  />
                </div>
                <button
                  type="button"
                  aria-label={`Slide ${index + 1}`}
                  aria-current={index === at ? 'true' : undefined}
                  disabled={editing}
                  className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-inset disabled:cursor-default"
                  onClick={() => onAt(index)}
                />
              </div>
            </li>
          ))}
        </ol>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <SlideFrame
          key={`${at}:${editing}`}
          title={`${title}, slide ${at + 1}`}
          source={slides[at] ?? ''}
          editing={editing}
          frame={frame}
          className="flex-1 px-(--inspector-inset) py-2"
        />
        <div className="flex shrink-0 items-center justify-center gap-0.5 pb-2 text-xs text-muted">
          <HoverTip tip="Previous slide">
            <button
              type="button"
              aria-label="Previous slide"
              disabled={editing || at === 0}
              className={iconButton}
              onClick={() => onAt(at - 1)}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
          </HoverTip>
          <span className="min-w-12 text-center tabular-nums" aria-live="polite">
            {at + 1} / {slides.length}
          </span>
          <HoverTip tip="Next slide">
            <button
              type="button"
              aria-label="Next slide"
              disabled={editing || at === last}
              className={iconButton}
              onClick={() => onAt(at + 1)}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </HoverTip>
          <HoverTip tip="Present">
            <button
              type="button"
              aria-label="Present"
              disabled={editing}
              className={iconButton}
              onClick={() => setPresenting(true)}
            >
              <PresentIcon size={15} aria-hidden="true" />
            </button>
          </HoverTip>
        </div>
      </div>

      {presenting && (
        <Presentation
          title={title}
          slides={slides}
          at={at}
          onAt={onAt}
          onClose={() => setPresenting(false)}
        />
      )}
    </div>
  );
}
