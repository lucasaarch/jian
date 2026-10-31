'use client';

import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { GatewayApi, Profile, ProtectionMode, Session } from '../../lib/api';
import { useAppearance } from '../../lib/appearance';
import { keys } from '../../lib/query/keys';
import { draftKey } from '../../lib/stores/drafts';
import { useSearchParams } from '../../platform/navigation';
import { AgentHero } from './agent-hero';
import { Composer } from './composer';
import { ContextRing } from './context-ring';
import { SessionModel } from './model-picker';
import { SessionProtection } from './protection-menu';

const openingTitle = (text: string, hasMedia: boolean) => {
  const opening = text.trim().replace(/\s+/g, ' ');
  if (!opening) return hasMedia ? 'Shared files' : 'New chat';
  return opening.length <= 60 ? opening : `${opening.slice(0, 59).trimEnd()}…`;
};

/**
 * A new chat, written before it exists: the conversation is created with its first upload or
 * message, never by opening the page, so an abandoned draft leaves nothing behind. Its model
 * and protection choices are its own; a project comes from the page that opened the draft.
 */
export function DraftPane({
  api,
  profile,
  project,
  opened,
  sent,
  refresh,
}: {
  api: GatewayApi;
  profile: Profile;
  /** The project it starts in, as a project's own new-chat button asks. */
  project: string | null;
  /** The draft became this conversation. */
  opened: (sessionId: string) => void;
  sent: () => void;
  refresh: () => void;
}) {
  const client = useQueryClient();
  const pane = useRef<HTMLElement>(null);
  const arriving = useSearchParams().has('welcome');
  const { still } = useAppearance();
  useEffect(() => {
    if (!arriving) return;
    // Focus waits for the visible arrival, including on phones where it can open the keyboard.
    const timer = setTimeout(
      () => pane.current?.querySelector('textarea')?.focus({ preventScroll: true }),
      still ? 0 : 1100,
    );
    return () => clearTimeout(timer);
  }, [arriving, still]);
  const [model, setModel] = useState<Session['model']>();
  const [protection, setProtection] = useState<ProtectionMode>('ask');
  const created = useRef<Promise<Session> | null>(null);
  const ensure = () => {
    created.current ??= api.createGatewaySession(profile.id, project, null);
    return created.current;
  };

  return (
    <section ref={pane} className="conversation-pane" aria-label="New chat">
      <div className="draft-empty">
        <AgentHero
          name={profile.name}
          avatar={profile.avatar}
          summary={profile.summary}
          {...(arriving ? { handoffId: profile.id } : {})}
        />
      </div>
      <motion.div
        initial={arriving && !still ? { opacity: 0, y: 32 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.75, delay: 0.3, ease: [0.23, 1, 0.32, 1] }}
      >
        <Composer
          draft
          draftKey={draftKey(profile.id)}
          modelControl={
            <>
              <ContextRing profileId={profile.id} />
              <SessionProtection
                api={api}
                profileId={profile.id}
                draft={protection}
                onDraftChange={setProtection}
              />
              <SessionModel
                api={api}
                profileId={profile.id}
                channel={false}
                draftModel={model}
                onDraftChange={setModel}
                className="composer-model-control"
                saved={refresh}
              />
            </>
          }
          name={profile.name}
          upload={async (file) => {
            const session = await ensure();
            return api.upload(profile.id, session.id, file);
          }}
          send={async (text, mediaIds) => {
            const session = await ensure();
            if (model) await api.setSessionModel(profile.id, session.id, model);
            // A conversation starts asking first; only a different choice needs saving.
            if (protection !== 'ask') {
              await api.setSessionProtection(profile.id, session.id, protection);
            }
            const named = await api.renameSession(
              profile.id,
              session.id,
              openingTitle(text, mediaIds.length > 0),
            );
            await api.send(profile.id, session.id, text, mediaIds);
            // Navigation can beat the sessions refresh. Seed the real record before opening it.
            const ready = { ...session, ...named, title: openingTitle(text, mediaIds.length > 0) };
            client.setQueryData<Session[]>(keys.sessions(profile.id), (known = []) => [
              ready,
              ...known.filter((item) => item.id !== ready.id),
            ]);
            created.current = null;
            opened(session.id);
          }}
          onSent={sent}
        />
      </motion.div>
    </section>
  );
}
