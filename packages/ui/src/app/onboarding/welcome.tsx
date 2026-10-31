'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { AgentHero } from '../../kit/agent-hero';
import type { Profile } from '../../lib/api';
import { useAppearance } from '../../lib/appearance';
import { readChat, Scene, SceneColumn, Stage } from './stage';

/** Long enough to read it, in milliseconds, however fast the chat was read. */
const LINGER = 1_800;
/** The most it holds the app back for a gateway slow to answer, in milliseconds. */
const PATIENCE = 6_000;

const WELCOMED = 'jian-welcomed';

/**
 * Whether this window has welcomed the owner already. Kept for the window's life and no longer: a
 * reload of the app is not a return, and the next launch is.
 */
export function welcomed(): boolean {
  try {
    return sessionStorage.getItem(WELCOMED) !== null;
  } catch {
    return true;
  }
}
export function rememberWelcome(): void {
  try {
    sessionStorage.setItem(WELCOMED, '1');
  } catch {
    /* It greets again on the next load: nothing is lost but a moment. */
  }
}

/**
 * The agent, on the stage where a first chat opens, greeting the owner as they come back. Its hero
 * then travels into the new chat. A read that fails or takes too long never holds the app: the
 * chat says what is wrong better than a welcome could, and shows what this computer kept.
 */
export function Welcome({
  profile,
  finish,
}: {
  profile: Profile;
  finish: (profile: Profile) => void;
}) {
  const client = useQueryClient();
  const { still } = useAppearance();
  // Read from a ref: a new `finish` from a render of the app must not start the wait over.
  const done = useRef(finish);
  done.current = finish;
  useEffect(() => {
    let active = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const after = (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push(setTimeout(resolve, ms));
      });
    rememberWelcome();
    void Promise.all([
      Promise.race([Promise.allSettled(readChat(client, profile.id)), after(PATIENCE)]),
      after(still ? 0 : LINGER),
    ]).then(() => {
      if (active) done.current(profile);
    });
    return () => {
      active = false;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [client, profile, still]);

  return (
    <Stage label="Welcome back">
      <SceneColumn>
        <Scene title="Welcome back." still={still}>
          <div className="mx-auto grid w-full max-w-md justify-items-center gap-8 py-6">
            <AgentHero
              name={profile.name}
              avatar={profile.avatar}
              summary={profile.summary}
              handoffId={profile.id}
            />
            <p className="text-center text-sm text-muted">
              {profile.name} has been waiting for you.
            </p>
            <p role="status" className="text-xs text-muted">
              Opening your chat…
            </p>
          </div>
        </Scene>
      </SceneColumn>
    </Stage>
  );
}
