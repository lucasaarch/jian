'use client';

import confetti from 'canvas-confetti';
import { useEffect, useRef } from 'react';
import type { ToolStep } from '../../lib/api';
import { useAppearance } from '../../lib/appearance';

/** The tool an agent calls to celebrate; the gateway does nothing else with it. */
const TOOL = 'throw_confetti';
/**
 * How recent a throw must be to fly, in milliseconds: one the agent just made, not one found in
 * a conversation reopened later. Generous for a clock that runs apart from the gateway's.
 */
const FRESH = 60_000;
/** How long the cannons keep firing, in milliseconds. */
const BURST = 1_100;
const COLOURS = ['#ff5e7e', '#ffb648', '#ffe066', '#4ade80', '#38bdf8', '#818cf8', '#f472b6'];

/** Throws already seen, across remounts: a conversation reopened does not throw them again. */
const thrown = new Set<string>();

/** The throws in `runs` that the agent just made and this screen has not shown. */
function fresh(runs: Map<string, ToolStep[]>, now: number): ToolStep[] {
  return [...runs.values()].flat().filter((step) => {
    if (step.toolName !== TOOL || step.status !== 'done' || thrown.has(step.toolCallId))
      return false;
    return now - Date.parse(step.finishedAt ?? step.startedAt) < FRESH;
  });
}

/**
 * Confetti over the conversation when its agent throws some: cannons in the bottom corners and
 * at the middle of each side, firing in towards the centre for a moment. Laid over the chat
 * only, never catching a click, and nothing under reduced motion.
 */
export function Confetti({ runs, off }: { runs: Map<string, ToolStep[]>; off: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cannons = useRef<{ fire: confetti.CreateTypes; frame: number }>(null);
  const { still } = useAppearance();

  // One cannon for the conversation's life: a step arriving mid-flight must not cut it short.
  useEffect(() => {
    if (!canvas.current) return;
    // No worker: a blob worker is something a strict content policy may refuse.
    const fire = confetti.create(canvas.current, { resize: true, useWorker: false });
    cannons.current = { fire, frame: 0 };
    return () => {
      if (cannons.current) cancelAnimationFrame(cannons.current.frame);
      cannons.current = null;
      fire.reset();
    };
  }, []);

  useEffect(() => {
    const due = fresh(runs, Date.now());
    if (!due.length) return;
    for (const step of due) thrown.add(step.toolCallId);
    const current = cannons.current;
    if (off || still || !current) return;
    const cannon = (x: number, y: number, angle: number, particleCount: number) =>
      current.fire({
        particleCount,
        angle,
        spread: 58,
        startVelocity: 62,
        gravity: 1.05,
        ticks: 260,
        scalar: 1.05,
        origin: { x, y },
        colors: COLOURS,
        disableForReducedMotion: true,
      });
    const end = performance.now() + BURST;
    const burst = () => {
      cannon(0, 1, 60, 7);
      cannon(1, 1, 120, 7);
      cannon(0, 0.55, 25, 3);
      cannon(1, 0.55, 155, 3);
      if (performance.now() < end) current.frame = requestAnimationFrame(burst);
    };
    burst();
  }, [runs, off, still]);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[5]">
      <canvas ref={canvas} className="block size-full" />
    </div>
  );
}
