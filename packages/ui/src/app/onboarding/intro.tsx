'use client';

import { ArrowRight } from 'lucide-react';
import { motion } from 'motion/react';
import { Mark } from '../../components/ui/mark';
import { Action } from '../../kit';

const settle = [0.23, 1, 0.32, 1] as const;

/**
 * A single entrance: the wing crosses, the name settles, and the line comes to rest. Every size
 * follows the window's height as well as its width, so the whole of it fits without a scroll in
 * a short window as in a tall one.
 */
export function WelcomeIntro({ still, begin }: { still: boolean; begin: () => void }) {
  return (
    <div className="grid justify-items-center gap-[clamp(1rem,4.5dvh,2.5rem)] text-center">
      <div
        aria-hidden="true"
        className="relative grid w-full max-w-3xl justify-items-center gap-2 pb-[clamp(1rem,4dvh,2.5rem)]"
      >
        <motion.div
          className="size-[clamp(2.5rem,8dvh,5rem)] [&_svg]:size-full"
          initial={still ? false : { opacity: 0, x: -40, y: 24, rotate: -12 }}
          animate={{ opacity: 1, x: 0, y: 0, rotate: 0 }}
          transition={{ duration: still ? 0 : 0.85, ease: 'easeInOut' }}
        >
          <Mark />
        </motion.div>
        {/* The J descends beyond the tight line box; the reveal needs room at every font size. */}
        <div className="-mb-[0.2em] w-full overflow-hidden pb-[calc(0.2em+0.75rem)] text-[clamp(4.5rem,min(20vw,24dvh),14rem)]">
          <motion.div
            className="font-hero leading-[0.9] font-black tracking-[-0.055em]"
            initial={still ? false : { opacity: 0, y: '65%' }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: still ? 0 : 0.9, delay: still ? 0 : 0.12, ease: settle }}
          >
            JIAN
          </motion.div>
        </div>
        <motion.div
          className="absolute inset-x-4 bottom-0 h-px origin-left bg-linear-to-r from-transparent via-ink/40 to-transparent sm:inset-x-16"
          initial={still ? false : { scaleX: 0, opacity: 0 }}
          animate={{ scaleX: 1, opacity: 1 }}
          transition={{ duration: still ? 0 : 0.9, delay: still ? 0 : 0.2, ease: 'easeInOut' }}
        />
      </div>
      <motion.div
        className="grid justify-items-center gap-[clamp(0.5rem,2dvh,1rem)]"
        initial={still ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: still ? 0 : 0.65, delay: still ? 0 : 0.3, ease: settle }}
      >
        <p className="text-[clamp(1.25rem,3.6dvh,1.875rem)] leading-tight font-medium tracking-tight text-balance">
          A little intelligence.
          <br />A world of possibility.
        </p>
        <p className="max-w-xs text-sm leading-relaxed text-muted sm:max-w-sm sm:text-base">
          An agent with your purpose. A place to think, make, and get things done.
        </p>
      </motion.div>
      <Action tone="primary" onClick={begin} className="h-[clamp(2.5rem,6dvh,3rem)] px-7">
        Meet your agent <ArrowRight size={16} aria-hidden="true" />
      </Action>
    </div>
  );
}
