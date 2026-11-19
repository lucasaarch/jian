'use client';

import { useEffect, useRef, useState } from 'react';
import { ScrollStrip } from '../../../../kit';
import { AddSlide } from './add-slide';
import { keyedChange, SlideThumb } from './slide-thumb';
import type { SlideOps } from './use-slide-ops';

/**
 * Every slide of a deck, small and numbered, in one row above the slide in view (slide-thumb.tsx):
 * the row scrolls sideways, and the slide in view is ringed and kept in sight. At its end, New
 * slide adds one after the slide in view, from a layout in the deck's look; each slide's own menu
 * and a drag do the rest of what the owner builds by hand (use-slide-ops.ts).
 */
export function SlideRail({
  slides,
  at,
  onAt,
  ops,
}: {
  slides: readonly string[];
  /** The slide in view, counted from 0. */
  at: number;
  onAt: (index: number) => void;
  /** The owner's changes to the slides, or none where the deck is only read. */
  ops?: SlideOps | undefined;
}) {
  // Where a dragged slide would land: before or after the one under the pointer.
  const [drop, setDrop] = useState<{ index: number; side: 'before' | 'after' }>();
  const rail = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!keyedChange.pending) return;
    keyedChange.pending = false;
    rail.current?.querySelector<HTMLButtonElement>('button[aria-current="true"]')?.focus();
  }, []);

  return (
    <nav
      ref={rail}
      aria-label="Slides"
      className="flex shrink-0 items-center pr-(--inspector-inset)"
    >
      <ScrollStrip
        active={String(at)}
        className="flex min-w-0 flex-1 gap-3 px-(--inspector-inset) py-2"
      >
        {slides.map((slide, index) => (
          <SlideThumb
            // biome-ignore lint/suspicious/noArrayIndexKey: a slide has no name but its place.
            key={index}
            slide={slide}
            index={index}
            count={slides.length}
            current={index === at}
            ops={ops}
            drop={drop?.index === index ? drop.side : undefined}
            onAt={onAt}
            onDragOver={(over, side) =>
              setDrop((now) =>
                side ? { index: over, side } : now?.index === over ? undefined : now,
              )
            }
            onDrop={(from) => {
              const landing = drop;
              setDrop(undefined);
              if (!landing || !ops) return;
              // The place it is dropped at, among the slides once it has left its own.
              const slot = landing.index + (landing.side === 'after' ? 1 : 0);
              ops.move(from, slot > from ? slot - 1 : slot);
            }}
          />
        ))}
      </ScrollStrip>
      {ops && <AddSlide disabled={ops.busy} onAdd={(what) => ops.add(at, what)} />}
    </nav>
  );
}
