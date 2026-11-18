'use client';

import { ScrollStrip } from '../../../../kit';
import { SlideFrame } from './slide-frame';

/**
 * Every slide of a deck, small and numbered, in one row above the slide in view: the row scrolls
 * sideways, and the slide in view is ringed and kept in sight. A slide here is looked at, not
 * used; the button over it is what a click and a key reach.
 *
 * A slide is two layers, the white sheet and the frame drawn on it, and the rounded corners cut
 * each by itself: where a corner's edge is softened, the sheet showed through the frame as a
 * pale arc around a dark slide. The filter on the box that holds them changes no colour; it is
 * there so the two are drawn as one picture first, and the corners cut that.
 */
export function SlideRail({
  slides,
  at,
  onAt,
  disabled,
}: {
  slides: readonly string[];
  /** The slide in view, counted from 0. */
  at: number;
  onAt: (index: number) => void;
  /** While a slide is open for editing, which another one must not replace. */
  disabled: boolean;
}) {
  return (
    <nav aria-label="Slides" className="shrink-0">
      <ScrollStrip active={String(at)} className="flex gap-3 px-(--inspector-inset) py-2">
        {slides.map((slide, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a slide has no name but its place.
          <div key={index} className="flex shrink-0 items-start gap-1.5">
            <span className="pt-0.5 text-[11px] text-muted tabular-nums">{index + 1}</span>
            <div
              className={`relative aspect-video w-24 overflow-hidden rounded-md ring-1 transition-shadow ${index === at ? 'ring-2 ring-accent' : 'ring-glass-edge'}`}
            >
              <div inert className="absolute inset-0 grid [filter:opacity(1)]">
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
                disabled={disabled}
                className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-inset disabled:cursor-default"
                onClick={() => onAt(index)}
              />
            </div>
          </div>
        ))}
      </ScrollStrip>
    </nav>
  );
}
