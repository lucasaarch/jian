'use client';

import type { QueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { type ReactNode, useEffect, useRef } from 'react';
import { queries } from '../../lib/query/profile';

const settle = [0.23, 1, 0.32, 1] as const;

/** The whole window, over its status bar too, with a glow at the top, where a scene plays. */
export function Stage({ label, children }: { label: string; children: ReactNode }) {
  return (
    <main
      aria-label={label}
      className="relative isolate flex h-dvh min-h-0 flex-col overflow-hidden bg-canvas text-ink select-none pt-[max(2.5rem,var(--chrome-top,0px))]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="absolute -top-64 left-1/2 h-[42rem] w-[60rem] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,var(--glass-press),transparent_65%)]" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </main>
  );
}

/** The column a scene stands in, in the middle of the stage. */
export function SceneColumn({ children }: { children: ReactNode }) {
  return (
    <div className="relative mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-6 py-[clamp(1rem,4dvh,2.5rem)] md:px-12">
      {children}
    </div>
  );
}

/** Focus moves only when a scene mounts, never on a preview update or a provider poll. */
export function Scene({
  title,
  hiddenTitle = false,
  still,
  children,
}: {
  title: string;
  /** Said to a screen reader alone, where the scene draws its own. */
  hiddenTitle?: boolean;
  still: boolean;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <motion.section
      className="grid gap-[clamp(1.25rem,4dvh,2rem)]"
      initial={{ opacity: 0, y: still ? 0 : 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: still ? 0 : -12 }}
      transition={{ duration: still ? 0.1 : 0.32, ease: settle }}
    >
      <motion.h1
        exit={{ opacity: 0, y: still ? 0 : -8 }}
        transition={{ duration: still ? 0.08 : 0.18 }}
        ref={heading}
        tabIndex={-1}
        className={`mx-auto max-w-2xl text-center text-balance outline-none ${hiddenTitle ? 'sr-only' : 'text-3xl font-semibold tracking-tight'}`}
      >
        {title}
      </motion.h1>
      {children}
    </motion.section>
  );
}

/** What a chat needs read, so the hero lands on a ready composer and not on another load. */
export const readChat = (client: QueryClient, profileId: string) => [
  client.fetchQuery(queries.sessions(profileId)),
  client.fetchQuery(queries.projects(profileId)),
  client.fetchQuery(queries.channels(profileId)),
  client.fetchQuery(queries.contacts(profileId)),
  client.fetchQuery(queries.activities(profileId)),
  client.fetchQuery(queries.groups()),
  client.fetchQuery(queries.modelDefaults()),
];
