'use client';

import { ArrowDown, Check, Download, LoaderCircle, TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Mark } from '../../components/ui';
import { useAppearance } from '../../lib/appearance';
import type { AppUpdate } from './app-update';

type Tone = 'busy' | 'down' | 'good' | 'ready' | 'warn' | 'none';

function toneOf(update: AppUpdate | undefined): Tone {
  switch (update?.status) {
    case undefined:
    case 'idle':
    case 'checking':
      return 'busy';
    case 'available':
    case 'downloading':
      return 'down';
    case 'latest':
      return 'good';
    case 'ready':
    case 'manual':
      return 'ready';
    case 'failed':
      return 'warn';
    default:
      return 'none';
  }
}

const badges: Record<Exclude<Tone, 'none'>, { className: string; icon: ReactNode }> = {
  busy: {
    className: 'bg-glass-press text-muted',
    icon: <LoaderCircle size={13} strokeWidth={2.5} className="animate-spin" />,
  },
  down: { className: 'bg-accent text-on-accent', icon: <ArrowDown size={13} strokeWidth={2.75} /> },
  good: { className: 'bg-good text-canvas', icon: <Check size={13} strokeWidth={3} /> },
  ready: { className: 'bg-good text-canvas', icon: <Download size={12} strokeWidth={2.75} /> },
  warn: { className: 'bg-warn text-canvas', icon: <TriangleAlert size={12} strokeWidth={2.75} /> },
};

/**
 * The app's mark on a tile of glass, with a badge for where the update stands. The badge springs
 * in on each change; a release ready to install breathes a ring, until motion is reduced.
 */
export function UpdateEmblem({ update }: { update: AppUpdate | undefined }) {
  const { still } = useAppearance();
  const tone = toneOf(update);
  const badge = tone === 'none' ? undefined : badges[tone];
  return (
    <div className="glass relative grid size-14 shrink-0 place-items-center rounded-[1.1rem]">
      {tone === 'ready' && !still && (
        <motion.span
          aria-hidden="true"
          className="absolute -inset-px rounded-[1.1rem] border-2 border-good/60"
          initial={{ opacity: 0.7, scale: 1 }}
          animate={{ opacity: 0, scale: 1.28 }}
          transition={{ duration: 1.8, ease: 'easeOut', repeat: Infinity, repeatDelay: 0.4 }}
        />
      )}
      <Mark className="size-8 text-ink" />
      {badge && (
        <motion.span
          key={tone}
          aria-hidden="true"
          className={`absolute -right-1.5 -bottom-1.5 grid size-6 place-items-center rounded-full shadow-sm ring-2 ring-surface ${badge.className}`}
          initial={still ? false : { scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 520, damping: 26 }}
        >
          {badge.icon}
        </motion.span>
      )}
    </div>
  );
}
