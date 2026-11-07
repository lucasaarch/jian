'use client';

import { useEffect, useRef } from 'react';

const wait = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

/** The attempts so far and the whole seconds to the next, rounded up so it reaches zero on time. */
function retryText(attempts: number, nextAt: number, now: number) {
  const left = Math.max(0, Math.ceil((nextAt - now) / 1000));
  return `attempt ${attempts} · ${left > 0 ? `next in ${wait(left)}` : 'trying now'}`;
}

/**
 * How long until a run tries its model again. It paints its own element every second, as the
 * Thought Line's clock does, so the countdown never draws the line or the answer again.
 */
export function RetryCountdown({
  attempts,
  nextAt,
  reason,
}: {
  attempts: number;
  nextAt: string;
  /** Why the last attempt failed, on hover: the line itself stays one short line. */
  reason?: string;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const due = Date.parse(nextAt);

  useEffect(() => {
    const paint = () => {
      if (element.current) element.current.textContent = retryText(attempts, due, Date.now());
    };
    paint();
    const id = setInterval(paint, 1000);

    return () => clearInterval(id);
  }, [attempts, due]);

  return (
    <span ref={element} className="thought-retry" title={reason} aria-hidden="true">
      {retryText(attempts, due, Date.now())}
    </span>
  );
}
