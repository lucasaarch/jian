import type { ReactNode } from 'react';

const tones = {
  quiet: 'bg-ink/8 text-muted',
  good: 'bg-good/15 text-good',
  warn: 'bg-warn/15 text-warn',
  bad: 'bg-bad/15 text-bad',
  /** What landed for good, in GitHub's purple: a merged pull request, a closed issue. */
  merged: 'bg-merged/15 text-merged',
} as const;

export type StatusTone = keyof typeof tones;

/** The pill's look, for something that opens more as well as saying how it stands. */
export const pillClass = (tone: StatusTone = 'quiet') =>
  `inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium leading-none whitespace-nowrap ${tones[tone]}`;

/** How something on a row stands, in a word or two: a tint, never an outline. */
export function StatusPill({
  tone = 'quiet',
  children,
}: {
  tone?: StatusTone;
  children: ReactNode;
}) {
  return <span className={pillClass(tone)}>{children}</span>;
}
