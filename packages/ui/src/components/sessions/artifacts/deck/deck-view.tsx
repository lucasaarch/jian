'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { KeyboardEvent, RefObject } from 'react';
import { HoverTip, iconButton } from '../../../../kit';
import { SlideCarousel } from './slide-carousel';
import { SlideRail } from './slide-rail';

/**
 * A deck in the Inspector: its slides small and numbered in a row on top (slide-rail.tsx), the
 * one in view large under them, in a track that is dragged or scrolled to the next
 * (slide-carousel.tsx), and under that the way to step through. Present is in the toolbar
 * (artifact-view.tsx). The three follow
 * one slide in view, `at`. Mount it with a key per version, so a new version's slides are new
 * frames.
 *
 * While the owner edits, it is the slide in view that is open for editing, and it stays in
 * view: moving to another would drop what was typed, so the rail, the track and the steps wait
 * for Done.
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
  /** The frame of the slide in view, for the one who keeps an edit. */
  frame: RefObject<HTMLIFrameElement | null>;
}) {
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={keyed}>
      <SlideRail slides={slides} at={at} onAt={onAt} disabled={editing} />
      <SlideCarousel
        title={title}
        slides={slides}
        at={at}
        onAt={onAt}
        editing={editing}
        frame={frame}
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
      </div>
    </div>
  );
}
