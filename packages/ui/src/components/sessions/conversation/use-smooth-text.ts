import { useEffect, useRef, useState } from 'react';

/** Characters revealed per second when little is waiting. */
export const BASE_CHARS_PER_SECOND = 80;
/** Whatever is waiting is shown within this long, so a big block never lags far behind. */
export const CATCH_UP_SECONDS = 0.5;
/** A cut lands on the next whitespace when it is this close, so words do not appear half-typed. */
const WORD_REACH = 12;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const cutAt = (text: string, from: number) => {
  const limit = Math.min(text.length, from + WORD_REACH);
  for (let at = from; at < limit; at++) if (/\s/.test(text[at] ?? '')) return at + 1;
  return from;
};

/**
 * Reveals `target` at a steady pace so chunked streaming reads as flowing text. The pace is the
 * base rate; a block above BLOCK_CHARS is cleared within the catch-up window, counted from when
 * it was noticed, at a rate that rises as the deadline nears so the tail cannot stretch out. Inactive or reduced motion
 * returns `target` whole and never schedules a frame. Text that stops extending what was shown
 * (a rewrite) restarts from the beginning.
 */
export function useSmoothText(target: string, active: boolean): string {
  const [shown, setShown] = useState('');
  const reduced = active && prefersReducedMotion();
  const live = active && !reduced;
  const shownRef = useRef('');
  const lastFrame = useRef<number | null>(null);
  const carry = useRef(0);
  const deadline = useRef(0);

  useEffect(() => {
    if (!live) {
      shownRef.current = '';
      lastFrame.current = null;
      carry.current = 0;
      return;
    }
    if (!target.startsWith(shownRef.current)) {
      shownRef.current = '';
      carry.current = 0;
      setShown('');
    }
    if (shownRef.current.length >= target.length) {
      lastFrame.current = null;
      return;
    }
    deadline.current = performance.now() + CATCH_UP_SECONDS * 1000;
    let frame = 0;
    const tick = (now: number) => {
      const elapsed = lastFrame.current === null ? 16 : Math.max(0, now - lastFrame.current);
      lastFrame.current = now;
      const length = shownRef.current.length;
      const backlog = target.length - length;
      const timeLeft = deadline.current - now;
      const rate = Math.max(
        BASE_CHARS_PER_SECOND,
        backlog / Math.max(timeLeft / 1000, elapsed / 1000),
      );
      carry.current += (rate * elapsed) / 1000;
      const step = now >= deadline.current ? backlog : Math.floor(carry.current);
      if (step > 0) {
        const raw = Math.min(target.length, length + step);
        const next = raw < target.length ? Math.max(raw, cutAt(target, raw)) : raw;
        // The word cut overshoots the step; owing it back keeps the average at the real rate.
        carry.current -= next - length;
        shownRef.current = target.slice(0, next);
        setShown(shownRef.current);
      }
      if (shownRef.current.length < target.length) frame = requestAnimationFrame(tick);
      else lastFrame.current = null;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, live]);

  if (!live) return target;
  return target.startsWith(shown) ? shown : '';
}
