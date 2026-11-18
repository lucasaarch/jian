'use client';

import { SLIDE_HEIGHT, SLIDE_WIDTH } from '@jian/contracts';
import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { watchSize } from '../../../../lib/watch-size';
import { ArtifactFrame } from '../artifact-frame';

/**
 * One slide of a deck, on its fixed canvas, scaled to the box it stands in. The slide is laid
 * out at its full size whatever room it is given, so a thumbnail and the screen of a
 * presentation show the same page, only smaller or larger. It is drawn in the same sealed frame
 * as any Artifact (artifact-frame.tsx), handed that one slide as its source.
 */
export function SlideFrame({
  title,
  source,
  editing = false,
  frame,
  lazy = false,
  className = '',
  onReady,
}: {
  title: string;
  source: string;
  editing?: boolean;
  frame?: RefObject<HTMLIFrameElement | null>;
  lazy?: boolean;
  onReady?: () => void;
  /**
   * The box: it needs a size of its own, which the slide then fits inside. Padding given here
   * is room kept around the slide, not room the slide is scaled to.
   */
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const next = Math.min(element.clientWidth / SLIDE_WIDTH, element.clientHeight / SLIDE_HEIGHT);
      // A box with no size yet, as one in a tab not shown, says nothing about the scale.
      if (next > 0) setScale(next);
    };

    measure();
    return watchSize(measure, element);
  }, []);

  return (
    // Two boxes, because an element's measured size counts its padding: scaled to the padded
    // box, a slide came out wider than the room inside it and ran past the panel's edge. The one
    // track is sized by the box alone, never by the slide in it.
    <div
      className={`grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] rounded-[inherit] ${className}`}
    >
      <div
        ref={box}
        className="grid min-h-0 min-w-0 place-items-center overflow-hidden rounded-[inherit]"
      >
        {/* The sheet a slide is drawn on is white wherever it is shown, here, in a presentation
            and on its public page. The white is the frame's own background, not a layer under
            it: two layers, each cut by the corner on its own, showed the white as a pale arc. */}
        <div
          className="relative shrink-0 overflow-hidden rounded-[inherit]"
          style={{ width: SLIDE_WIDTH * scale, height: SLIDE_HEIGHT * scale }}
        >
          <ArtifactFrame
            type="deck"
            title={title}
            source={source}
            editing={editing}
            scale={scale}
            lazy={lazy}
            {...(onReady ? { onReady } : {})}
            {...(frame ? { frame } : {})}
            className="absolute top-0 left-0 max-w-none origin-top-left border-0"
            style={{
              width: SLIDE_WIDTH,
              height: SLIDE_HEIGHT,
              transform: `scale(${scale})`,
              background: '#fff',
            }}
          />
        </div>
      </div>
    </div>
  );
}
