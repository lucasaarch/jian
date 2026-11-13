'use client';

import { type PointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { GRAPH_HEIGHT, GRAPH_WIDTH } from './graph-layout';

type View = { x: number; y: number; w: number; h: number };

const WHOLE: View = { x: 0, y: 0, w: GRAPH_WIDTH, h: GRAPH_HEIGHT };
/** How far in and out the map goes, as a share of the whole drawing shown. */
const CLOSEST = 1 / 6;
const FARTHEST = 1.6;
/** A press that moves less than this is a click, not a drag, in screen pixels. */
const DRAG_FROM = 4;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * Pan and zoom of a drawing in an SVG: the wheel zooms where the pointer is, a drag on the
 * background moves it. `dragged` tells a node's click that the press was a drag, so a pan that
 * ends over a node does not select it.
 */
export function usePanZoom() {
  const svg = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>(WHOLE);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);

  /** Screen pixels to drawing units under the current view, with `meet`'s letterbox. */
  const unitsOf = useCallback((from: View) => {
    const box = svg.current?.getBoundingClientRect();
    const unit = box ? Math.min(box.width / from.w, box.height / from.h) || 1 : 1;

    return { box, unit };
  }, []);

  const zoom = useCallback(
    (factor: number, at?: { x: number; y: number }) =>
      setView((from) => {
        const w = clamp(from.w / factor, GRAPH_WIDTH * CLOSEST, GRAPH_WIDTH * FARTHEST);
        const h = (w * GRAPH_HEIGHT) / GRAPH_WIDTH;
        const { box, unit } = unitsOf(from);
        // The point under the pointer stays under it; with none, the middle does.
        const fx =
          at && box ? (at.x - box.left - (box.width - from.w * unit) / 2) / unit : from.w / 2;
        const fy =
          at && box ? (at.y - box.top - (box.height - from.h * unit) / 2) / unit : from.h / 2;

        return {
          x: from.x + fx - (fx * w) / from.w,
          y: from.y + fy - (fy * h) / from.h,
          w,
          h,
        };
      }),
    [unitsOf],
  );

  useEffect(() => {
    const node = svg.current;
    if (!node) return;
    // Not passive: the page must not scroll while the map zooms.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(Math.exp(-event.deltaY * 0.0015), { x: event.clientX, y: event.clientY });
    };

    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [zoom]);

  const handlers = {
    onPointerDown: (event: PointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return;
      press.current = { x: event.clientX, y: event.clientY, moved: false };
      dragged.current = false;
    },
    onPointerMove: (event: PointerEvent<SVGSVGElement>) => {
      const from = press.current;
      if (!from) return;
      const dx = event.clientX - from.x;
      const dy = event.clientY - from.y;

      if (!from.moved && Math.hypot(dx, dy) < DRAG_FROM) return;
      if (!from.moved) event.currentTarget.setPointerCapture(event.pointerId);
      from.moved = true;
      dragged.current = true;
      press.current = { x: event.clientX, y: event.clientY, moved: true };
      setView((now) => {
        const { unit } = unitsOf(now);

        return { ...now, x: now.x - dx / unit, y: now.y - dy / unit };
      });
    },
    onPointerUp: () => {
      press.current = null;
      // The click that follows a drag arrives after this; it clears the flag itself.
      setTimeout(() => {
        dragged.current = false;
      }, 0);
    },
  };

  return {
    svg,
    dragged,
    handlers,
    viewBox: `${view.x} ${view.y} ${view.w} ${view.h}`,
    zoomIn: () => zoom(1.4),
    zoomOut: () => zoom(1 / 1.4),
    reset: () => setView(WHOLE),
  };
}
