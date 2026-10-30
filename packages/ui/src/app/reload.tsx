'use client';

import { motion } from 'motion/react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { Mark } from '../components/ui';
import { useAppearance } from '../lib/appearance';

/** Carried across the reload, so the page that loads finishes what the one leaving began. */
const RELOADING = 'jian-reloading';
/** The glass misting over and the mark settling, in milliseconds, before the page loads again. */
const LEAVE = 900;
/** From the new page's first paint to the glass gone: its 220ms wait and 900ms clearing. */
const RETURN = 1_150;
const settle = [0.7, 0, 0.2, 1] as const;

type Phase = 'idle' | 'leaving' | 'returning';

/** Whether this page is the one a reload of the app brought, read once and forgotten. */
function returning(): boolean {
  try {
    const was = sessionStorage.getItem(RELOADING) !== null;
    sessionStorage.removeItem(RELOADING);
    return was;
  } catch {
    return false;
  }
}

let begin: (() => void) | undefined;
/** The flag is read by the first curtain to mount, once: development mounts effects twice. */
let read = false;

/**
 * Loads the app again, the one way it is reloaded: the curtain closes over it, the page loads
 * behind it, and it opens on the new one. Without a curtain mounted, it simply reloads.
 */
export function reloadApp(): void {
  if (begin) begin();
  else window.location.reload();
}

/**
 * The glass a reload passes behind: it mists over the app as the Jian mark comes into focus,
 * the page loads again behind it, and on the new page it clears as the mark lifts away. Under
 * reduced motion the page simply reloads.
 */
export function ReloadCurtain() {
  const { still } = useAppearance();
  const [phase, setPhase] = useState<Phase>('idle');

  // Before the first paint, so the new page never shows without its curtain; after the server's
  // render, which has no session to read.
  useLayoutEffect(() => {
    if (read) return;
    read = true;
    if (returning()) setPhase('returning');
  }, []);

  useEffect(() => {
    begin = () => {
      if (still) return window.location.reload();
      setPhase('leaving');
    };
    return () => {
      begin = undefined;
    };
  }, [still]);

  useEffect(() => {
    if (phase === 'idle') return;
    const timer = setTimeout(
      () => {
        if (phase === 'returning') return setPhase('idle');
        try {
          sessionStorage.setItem(RELOADING, '1');
        } catch {
          // The new page opens without its curtain: nothing is lost but the flourish.
        }
        window.location.reload();
      },
      phase === 'leaving' ? LEAVE : RETURN,
    );
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === 'idle' || (still && phase === 'returning')) return null;

  return (
    <div
      aria-hidden="true"
      data-phase={phase}
      className="reload-curtain fixed inset-0 z-[2147483000] grid place-items-center text-ink"
    >
      <motion.span
        className="relative size-16 [&_svg]:size-full"
        initial={
          phase === 'leaving'
            ? { opacity: 0, scale: 0.4, rotate: -24, filter: 'blur(8px)' }
            : { opacity: 1, scale: 1, rotate: 0, y: 0, filter: 'blur(0px)' }
        }
        animate={
          phase === 'leaving'
            ? { opacity: 1, scale: 1, rotate: 0, filter: 'blur(0px)' }
            : { opacity: 0, scale: 1.2, y: -28, filter: 'blur(8px)' }
        }
        transition={
          phase === 'leaving'
            ? { duration: 0.6, delay: 0.22, ease: [0.23, 1, 0.32, 1] }
            : { duration: 0.5, delay: 0.12, ease: settle }
        }
      >
        <Mark />
      </motion.span>
    </div>
  );
}
