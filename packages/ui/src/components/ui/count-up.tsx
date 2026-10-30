'use client';

import { useMotionValue, useSpring } from 'motion/react';
import { useEffect, useRef } from 'react';
import { useAppearance } from '../../lib/appearance';
import { LOCALE } from '../../lib/format';

/**
 * A number that counts to a new value when it changes while on screen, adapted from React Bits'
 * CountUp. The first value is shown as it is: a page that opens counting from zero makes the
 * reader wait for numbers it already has. With motion reduced every change is shown at once. A
 * reader of the screen hears the value, never the numbers passing on the way.
 */
export function CountUp({
  value,
  duration = 1.2,
  className = '',
  format: shown,
}: {
  value: number;
  /** Seconds, roughly: it sets the spring's stiffness and damping. */
  duration?: number;
  className?: string;
  /** How a number is written while it counts; whole numbers with separators by default. */
  format?: (value: number) => string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const { still } = useAppearance();
  const motion = useMotionValue(value);
  const spring = useSpring(motion, {
    damping: 20 + 40 * (1 / duration),
    stiffness: 100 * (1 / duration),
  });
  const format = shown ?? ((latest: number) => Math.round(latest).toLocaleString(LOCALE));
  // Rendered once and then left to the spring: rendering each new value would write the end of
  // the count before the count, and the number would jump there and back.
  const first = useRef(value);

  useEffect(() => {
    if (still) {
      spring.jump(value);
      motion.jump(value);
    } else {
      motion.set(value);
    }
  }, [still, value, motion, spring]);

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
        {format(first.current)}
      </span>
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}
