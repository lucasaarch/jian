'use client';

import { useInView, useMotionValue, useSpring } from 'motion/react';
import { useEffect, useRef } from 'react';
import { useAppearance } from '../../lib/appearance';
import { LOCALE } from '../../lib/format';

/**
 * A number that counts to its value, adapted from React Bits' CountUp. It counts up from
 * zero the first time it is on screen, and from what it showed to the new value when the value
 * changes live, rather than starting over. With motion reduced it shows the value at once. A
 * reader of the screen hears the value, never the numbers passing on the way.
 */
export function CountUp({
  value,
  duration = 1.2,
  className = '',
}: {
  value: number;
  /** Seconds, roughly: it sets the spring's stiffness and damping. */
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const { still } = useAppearance();
  const motion = useMotionValue(0);
  const spring = useSpring(motion, {
    damping: 20 + 40 * (1 / duration),
    stiffness: 100 * (1 / duration),
  });
  const seen = useInView(ref, { once: true, margin: '0px' });
  const format = (latest: number) => Math.round(latest).toLocaleString(LOCALE);

  useEffect(() => {
    if (!seen) return;
    if (still) {
      spring.jump(value);
      motion.jump(value);
    } else {
      motion.set(value);
    }
  }, [seen, still, value, motion, spring]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The format is the same every render.
  useEffect(
    () =>
      spring.on('change', (latest) => {
        if (ref.current) ref.current.textContent = format(latest);
      }),
    [spring],
  );

  return (
    <span className={className}>
      <span ref={ref} aria-hidden="true">
        {format(still ? value : 0)}
      </span>
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}
