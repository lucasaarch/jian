'use client';

import { motion } from 'motion/react';
import { useAppearance } from '../lib/appearance';
import { AgentFace } from './face';

/**
 * How wide a capital of the hero's black serif runs, as a share of its size: a word of n letters
 * is about n times this wide. Rounded up so the longest word keeps a margin either side.
 */
const LETTER = 0.78;

/**
 * Where a new chat opens: the agent's face, its name set large in capitals, a word to a line,
 * and under it what the agent is for. The longest word decides the size — it fills the column's
 * width and no more — so a short name stands tall and a long one comes down to fit, never cut
 * and never small for no reason.
 */
export function AgentHero({
  name,
  avatar,
  summary,
  handoffId,
}: {
  name: string;
  avatar?: string | null;
  summary?: string;
  /** Only the first-run hero shares its position across the Welcome and the new chat. */
  handoffId?: string;
}) {
  const { still } = useAppearance();
  const Surface = handoffId ? motion.div : 'div';
  const words = name.trim().split(/\s+/);
  const longest = Math.max(1, ...words.map((word) => [...word].length));

  const shared = (part: string) =>
    handoffId
      ? {
          layoutId: `welcome-agent-${handoffId}-${part}`,
          layout: 'position' as const,
          transition: { layout: { duration: still ? 0 : 1.05, ease: [0.23, 1, 0.32, 1] as const } },
        }
      : {};

  return (
    <div className="flex w-full flex-col items-center gap-6 [container-type:inline-size]">
      <Surface {...shared('face')}>
        <AgentFace name={name} avatar={avatar} size={5} />
      </Surface>
      <Surface {...shared('identity')} className="grid max-w-full justify-items-center gap-3">
        <h2
          className="max-w-full text-center font-hero font-black text-ink uppercase leading-[0.9] tracking-[0.01em] whitespace-pre-line [overflow-wrap:anywhere]"
          style={{
            fontSize: `clamp(2.25rem, calc(100cqi / ${(longest * LETTER).toFixed(2)}), 7.5rem)`,
          }}
        >
          {words.join('\n')}
        </h2>
        <p className="max-w-md text-center text-sm leading-relaxed text-muted">
          {summary?.trim() || 'Ask anything, or hand over something to get done.'}
        </p>
      </Surface>
    </div>
  );
}
