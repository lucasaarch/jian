'use client';

import { AnimatePresence, LayoutGroup, motion, useIsPresent } from 'motion/react';
import { type ReactNode, useId } from 'react';
import { useAppearance } from '../../lib/appearance';

/** Both surfaces coexist while the shared hero travels; the departing surface stops accepting input. */
export function WelcomeHandoff({ welcome, children }: { welcome: ReactNode; children: ReactNode }) {
  const id = useId();
  const { still } = useAppearance();
  return (
    <LayoutGroup id={id}>
      <div className="relative h-(--app-height) overflow-hidden">
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
              transition={{
                duration: still ? 0.12 : 0.8,
                delay: still ? 0 : 0.15,
                ease: [0.23, 1, 0.32, 1],
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
      className="absolute inset-0"
      inert={!present}
      aria-hidden={!present || undefined}
      exit={{ opacity: 0 }}
      transition={{ duration: still ? 0.12 : 0.65, ease: 'easeInOut' }}
    >
      {children}
    </motion.div>
  );
}
