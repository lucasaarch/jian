'use client';

import { useEffect, useRef, useState } from 'react';

const MIN = 1;
const MAX = 6;
/** Where a double-click zooms to: close enough to read, far enough to see around it. */
const DOUBLE_CLICK_SCALE = 2.5;

type View = { scale: number; x: number; y: number };

const clamp = (value: number) => Math.min(MAX, Math.max(MIN, value));

/**
 * A picture that zooms the way photos do: a pinch on a touch screen or a trackpad, the wheel
 * with Ctrl, or a double-click, always around the point under the fingers or the cursor. Once
 * zoomed it pans by dragging or scrolling, and back at its size it sits still in the middle.
 */
export function ZoomableImage({
  src,
  alt,
  dismiss,
}: {
  src: string;
  alt: string;
  /** Called on a click beside the picture, which reads as a click outside it. */
  dismiss: () => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const current = useRef(view);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; view: View } | null>(null);
  // Safari's trackpad pinch reports the whole gesture's scale, not a step of it.
  const gesture = useRef<View | null>(null);
  // Where the last press began: a press that became a drag is not a click.
  const pressed = useRef({ x: 0, y: 0 });

  current.current = view;

  /** The new view with the point at (clientX, clientY) held under the same pixel. */
  const zoomAt = (from: View, scale: number, clientX: number, clientY: number): View => {
    const rect = frame.current?.getBoundingClientRect();
    const next = clamp(scale);

    if (!rect || next === MIN) return { scale: MIN, x: 0, y: 0 };
    const px = clientX - (rect.left + rect.width / 2);
    const py = clientY - (rect.top + rect.height / 2);

    return {
      scale: next,
      x: px - ((px - from.x) / from.scale) * next,
      y: py - ((py - from.y) / from.scale) * next,
    };
  };

  useEffect(() => {
    const element = frame.current;

    if (!element) return;

    // Not a React handler: a passive listener cannot stop the page from zooming instead.
    const wheel = (event: WheelEvent) => {
      const from = current.current;

      if (event.ctrlKey) {
        event.preventDefault();
        setView(
          zoomAt(from, from.scale * Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY),
        );
      } else if (from.scale > 1) {
        event.preventDefault();
        setView({ ...from, x: from.x - event.deltaX, y: from.y - event.deltaY });
      }
    };
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    const gestureStart = (event: Event) => {
      event.preventDefault();
      gesture.current = current.current;
    };
    const gestureChange = (event: Event) => {
      const { scale, clientX, clientY } = event as Gesture;

      event.preventDefault();
      if (gesture.current)
        setView(zoomAt(gesture.current, gesture.current.scale * scale, clientX, clientY));
    };

    element.addEventListener('wheel', wheel, { passive: false });
    element.addEventListener('gesturestart', gestureStart);
    element.addEventListener('gesturechange', gestureChange);

    return () => {
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('gesturestart', gestureStart);
      element.removeEventListener('gesturechange', gestureChange);
    };
  });

  const distance = () => {
    const [a, b] = [...pointers.current.values()];

    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  return (
    <div
      ref={frame}
      role="application"
      aria-label={`${alt}. Pinch, Ctrl and scroll, or + and - to zoom; 0 fits it again.`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the keyboard zoom needs a focus to land on.
      tabIndex={0}
      onKeyDown={(event) => {
        const rect = frame.current?.getBoundingClientRect();
        const x = rect ? rect.left + rect.width / 2 : 0;
        const y = rect ? rect.top + rect.height / 2 : 0;

        if (event.key === '+' || event.key === '=')
          setView(zoomAt(current.current, current.current.scale * 1.5, x, y));
        if (event.key === '-') setView(zoomAt(current.current, current.current.scale / 1.5, x, y));
        if (event.key === '0') setView({ scale: 1, x: 0, y: 0 });
      }}
      className="zoom-frame"
      data-zoomed={view.scale > 1}
      onClick={(event) => {
        const still =
          Math.hypot(event.clientX - pressed.current.x, event.clientY - pressed.current.y) < 5;
        // By position, not target: the drag's pointer capture makes every click land on the frame.
        const picture = event.currentTarget.querySelector('img')?.getBoundingClientRect();
        const beside =
          !picture ||
          event.clientX < picture.left ||
          event.clientX > picture.right ||
          event.clientY < picture.top ||
          event.clientY > picture.bottom;

        if (still && beside) dismiss();
      }}
      onPointerDown={(event) => {
        pressed.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size === 2)
          pinch.current = { distance: distance(), view: current.current };
      }}
      onPointerMove={(event) => {
        const last = pointers.current.get(event.pointerId);

        if (!last) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (pinch.current && pointers.current.size === 2) {
          const [a, b] = [...pointers.current.values()];

          if (a && b)
            setView(
              zoomAt(
                pinch.current.view,
                (pinch.current.view.scale * distance()) / pinch.current.distance,
                (a.x + b.x) / 2,
                (a.y + b.y) / 2,
              ),
            );
        } else if (current.current.scale > 1) {
          setView({
            ...current.current,
            x: current.current.x + event.clientX - last.x,
            y: current.current.y + event.clientY - last.y,
          });
        }
      }}
      onPointerUp={(event) => {
        pointers.current.delete(event.pointerId);
        if (pointers.current.size < 2) pinch.current = null;
      }}
      onPointerCancel={(event) => {
        pointers.current.delete(event.pointerId);
        pinch.current = null;
      }}
      onDoubleClick={(event) =>
        setView(
          current.current.scale > 1
            ? { scale: 1, x: 0, y: 0 }
            : zoomAt(current.current, DOUBLE_CLICK_SCALE, event.clientX, event.clientY),
        )
      }
    >
      {/* biome-ignore lint/performance/noImgElement: Private attachment fetched through the authenticated API. */}
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      />
    </div>
  );
}
