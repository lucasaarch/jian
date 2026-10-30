'use client';

import { motion } from 'motion/react';
import { useAppearance } from '../lib/appearance';

/**
 * How far something long has come: a thin bar whose fill eases to each new value. Without a
 * value it says only that the work is under way, with a sweep that stops when motion is reduced.
 */
export function Progress({ value, label }: { /** 0 to 1. */ value?: number; label: string }) {
  const { still } = useAppearance();
  const percent =
    value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-glass-press"
    >
      {percent === undefined ? (
        <motion.div
          className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent/70"
          initial={{ x: still ? '100%' : '-100%' }}
          animate={still ? { x: '100%' } : { x: ['-100%', '300%'] }}
          transition={
            still ? { duration: 0 } : { duration: 1.4, ease: 'easeInOut', repeat: Infinity }
          }
        />
      ) : (
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}
