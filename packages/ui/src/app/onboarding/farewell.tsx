'use client';

import { motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { AgentHero } from '../../kit/agent-hero';
import { useAppearance } from '../../lib/appearance';
import type { DepartedAgent } from '../../lib/stores/onboarding';
import { Scene, SceneColumn, Stage } from './stage';

/** When the agent starts to go and how long that takes, in seconds. */
const STAYS = 1.1;
const GOES = 1.3;

/**
 * The stage where an agent first arrived, seeing it off: it stands there a moment, then dissolves
 * upward and is gone. By now it is deleted, so nothing here can fail or be taken back; `done` is
 * called on a timer, as reduced motion may suppress animation events.
 */
export function Farewell({ agent, done }: { agent: DepartedAgent; done: () => void }) {
  const { still } = useAppearance();
  // Read from a ref: a new `done` from a render of the app must not start the wait over.
  const finish = useRef(done);
  finish.current = done;
  useEffect(() => {
    const timer = setTimeout(() => finish.current(), still ? 1_200 : (STAYS + GOES) * 1_000);
    return () => clearTimeout(timer);
  }, [still]);

  return (
    <Stage label="Goodbye">
      <SceneColumn>
        <Scene title="Goodbye." still={still}>
          <div className="mx-auto grid w-full max-w-md justify-items-center gap-8 py-6">
            <motion.div
              className="w-full"
              {...(still
                ? {}
                : {
                    animate: { opacity: 0, y: -24, scale: 0.97, filter: 'blur(16px)' },
                    transition: {
                      delay: STAYS,
                      duration: GOES,
                      ease: [0.4, 0, 0.6, 1] as const,
                    },
                  })}
            >
              <AgentHero
                name={agent.name}
                avatar={agent.avatar ?? null}
                {...(agent.summary ? { summary: agent.summary } : {})}
              />
            </motion.div>
            <p className="text-center text-sm text-muted">
              Thanks for everything. Its chats and memories went with it.
            </p>
          </div>
        </Scene>
      </SceneColumn>
    </Stage>
  );
}
