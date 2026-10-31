'use client';

import { AnimatePresence, LayoutGroup, motion, useIsPresent } from 'motion/react';
import { type ReactNode, useId } from 'react';
import { useAppearance } from '../../lib/appearance';

const settle = [0.23, 1, 0.32, 1] as const;

/**
 * Both surfaces coexist while one gives way to the other. Called up from inside the app, the stage
 * settles over it as the app steps back; leaving, it fades while the shared hero travels into the
 * chat. The departing surface stops accepting input.
 */
export function WelcomeHandoff({ welcome, children }: { welcome: ReactNode; children: ReactNode }) {
  const id = useId();
  const { still } = useAppearance();
  return (
    <LayoutGroup id={id}>
      <div className="relative h-(--app-height)">
        <AnimatePresence initial={false}>
          {welcome ? (
            <Departing key="welcome" still={still}>
              {welcome}
            </Departing>
          ) : (
            <motion.div
              key="chats"
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{
                opacity: 0,
                scale: still ? 1 : 0.97,
                transition: { duration: still ? 0.12 : 0.6, ease: settle },
              }}
              transition={{
                duration: still ? 0.12 : 0.8,
                delay: still ? 0 : 0.15,
                ease: settle,
              }}
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  );
}

function Departing({ still, children }: { still: boolean; children: ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div
      // Taller than the app, whose status bar it covers: nothing moves as a stage comes or goes.
      className="absolute inset-x-0 top-0 h-dvh"
      // Above the app it settles over; leaving, under the one the hero travels into.
      style={{ zIndex: present ? 10 : 0 }}
      inert={!present}
      aria-hidden={!present || undefined}
      initial={{ opacity: 0, scale: still ? 1 : 1.02 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: still ? 0.12 : 0.65, ease: 'easeInOut' }}
    >
      {children}
    </motion.div>
  );
}
