import { useEffect, useRef, useState } from 'react';

/** Characters revealed per second when little is waiting. */
export const BASE_CHARS_PER_SECOND = 80;
/** Whatever is waiting is shown within this long, so a big block never lags far behind. */
export const CATCH_UP_SECONDS = 0.5;
/**
 * A backlog above this is a block that arrived at once. Smaller ones drain at the base rate; a
 * proportional rate on them would show 400 characters almost instantly and defeat the pacing.
 */
const BLOCK_CHARS = 600;
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
  const deadline = useRef<number | null>(null);

  useEffect(() => {
    if (!live) {
      shownRef.current = '';
      lastFrame.current = null;
      carry.current = 0;
      deadline.current = null;
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
    let frame = 0;
    const tick = (now: number) => {
      const elapsed = lastFrame.current === null ? 16 : Math.max(0, now - lastFrame.current);
      lastFrame.current = now;
      const length = shownRef.current.length;
      const backlog = target.length - length;
      if (deadline.current === null && backlog > BLOCK_CHARS)
        deadline.current = now + CATCH_UP_SECONDS * 1000;
      const left = deadline.current === null ? 0 : Math.max(deadline.current - now, elapsed);
      const rate =
        deadline.current === null
          ? BASE_CHARS_PER_SECOND
          : Math.max(BASE_CHARS_PER_SECOND, (backlog * 1000) / left);
      carry.current += (rate * elapsed) / 1000;
      const step = Math.floor(carry.current);
      if (step > 0) {
        carry.current -= step;
        const raw = Math.min(target.length, length + step);
        const next = raw < target.length ? Math.max(raw, cutAt(target, raw)) : raw;
        shownRef.current = target.slice(0, next);
        setShown(shownRef.current);
      }
      if (shownRef.current.length < target.length) frame = requestAnimationFrame(tick);
      else {
        lastFrame.current = null;
        deadline.current = null;
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, live]);

  if (!live) return target;
  return target.startsWith(shown) ? shown : '';
}
