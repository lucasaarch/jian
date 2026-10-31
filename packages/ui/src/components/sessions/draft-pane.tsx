'use client';

import type { GatewaySettings } from '@jian/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type {
  GatewayApi,
  Message,
  ModelDefaults,
  ModelDefaultsInput,
  Profile,
  ProtectionMode,
  Session,
} from '../../lib/api';
import { useAppearance } from '../../lib/appearance';
import { keys } from '../../lib/query/keys';
import { draftKey, useDrafts } from '../../lib/stores/drafts';
import { useSearchParams } from '../../platform/navigation';
import { AgentHero } from './agent-hero';
import { Composer } from './composer';
import { ContextRing } from './context-ring';
import { adoptInspector } from './inspector-host';
import { ChatMessage } from './message';
import { SessionModel } from './model-picker';
import { SessionProtection } from './protection-menu';
import { ThoughtLine } from './thought-line';
import { TroubleCard } from './trouble';

const openingTitle = (text: string, hasMedia: boolean) => {
  const opening = text.trim().replace(/\s+/g, ' ');
  if (!opening) return hasMedia ? 'Shared files' : 'New chat';
  return opening.length <= 60 ? opening : `${opening.slice(0, 59).trimEnd()}…`;
};

/** A first message on its way: on screen at once, while the chat is made behind it. */
type Sending = {
  text: string;
  mediaIds: string[];
  /** One press is one message, however many times it has to be tried. */
  requestKey: string;
  startedAt: string;
  failed?: string;
};

const NO_PEOPLE = new Map();

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
  const [chosenProtection, setProtection] = useState<ProtectionMode>();
  const { data: settings } = useQuery({
    queryKey: keys.settings,
    queryFn: () => api.settings(),
  });
  // Where the last new chat started, until the owner chooses for this one.
  const protection = chosenProtection ?? settings?.newChatProtection ?? 'ask';
  const created = useRef<Promise<Session> | null>(null);
  const ensure = () => {
    created.current ??= api.createGatewaySession(profile.id, project, null).catch((failure) => {
      // Nothing was made, so trying again has to ask again.
      created.current = null;
      throw failure;
    });
    return created.current;
  };
  const [sending, setSending] = useState<Sending>();
  const [composerRound, setComposerRound] = useState(0);
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  const words = draftKey(profile.id);

  /**
   * This chat's choices are where the next one starts. Worth having, not worth failing over: a
   * gateway from before this answers no, and the message has gone regardless.
   */
  const remember = () => {
    const defaults = client.getQueryData<ModelDefaults>(keys.modelDefaults);
    if (model && defaults && JSON.stringify(model) !== JSON.stringify(defaults.conversation)) {
      client.setQueryData<ModelDefaults>(keys.modelDefaults, { ...defaults, conversation: model });
      const { updatedAt: _saved, ...input } = defaults;
      void api
        .setModelDefaults({ ...input, conversation: model } as ModelDefaultsInput)
        .catch(() => {});
    }
    if (protection !== (settings?.newChatProtection ?? 'ask')) {
      client.setQueryData<GatewaySettings>(keys.settings, (known) =>
        known ? { ...known, newChatProtection: protection } : known,
      );
      void api.updateSettings({ newChatProtection: protection }).catch(() => {});
    }
  };

  /** Everything the chat needs, under a message already on screen. */
  const start = async (message: Sending) => {
    try {
      const session = await ensure();
      const title = openingTitle(message.text, message.mediaIds.length > 0);
      // The sidebar shows the chat as soon as it exists; the rest follows behind it.
      client.setQueryData<Session[]>(keys.sessions(profile.id), (known = []) => [
        { ...session, title },
        ...known.filter((item) => item.id !== session.id),
      ]);
      await Promise.all([
        model ? api.setSessionModel(profile.id, session.id, model) : undefined,
        // A conversation starts asking first; only a different choice needs saving.
        protection !== 'ask'
          ? api.setSessionProtection(profile.id, session.id, protection)
          : undefined,
        api.renameSession(profile.id, session.id, title),
      ]);
      const run = await api.send(
        profile.id,
        session.id,
        message.text,
        message.mediaIds,
        message.requestKey,
      );
      created.current = null;
      useDrafts.getState().write(words, '');
      // Left already: the message is delivered, and the owner's place is theirs.
      if (!here.current) return;
      // The conversation opens with what is on screen now, and reads the rest under it.
      const shown: Message = {
        id: message.requestKey,
        profileId: profile.id,
        sessionId: session.id,
        runId: run.id,
        role: 'user',
        content: message.text,
        createdAt: message.startedAt,
        reactions: [],
      } as Message;
      client.setQueryData(['history', profile.id, session.id], {
        messages: [shown],
        tools: [],
        asks: [],
        callTools: [],
        subagents: [],
        people: [],
        run,
      });
      adoptInspector(session.id);
      opened(session.id);
      sent();
      remember();
    } catch (failure) {
      if (!here.current) return;
      setSending({
        ...message,
        failed: failure instanceof Error ? failure.message : 'The gateway did not answer.',
      });
    }
  };

  return (
    <section ref={pane} className="conversation-pane" aria-label="New chat">
      {sending ? (
        <div className="message-history" aria-busy={!sending.failed}>
          <div className="message-list">
            <ChatMessage
              message={
                {
                  id: sending.requestKey,
                  profileId: profile.id,
                  sessionId: sending.requestKey,
                  role: 'user',
                  content: sending.text,
                  createdAt: sending.startedAt,
                  reactions: [],
                } as Message
              }
              group={false}
              people={NO_PEOPLE}
              opensRun
              agent={profile}
            />
            {!sending.failed && (
              <div className="chat-line theirs work">
                <ThoughtLine working startedAt={sending.startedAt} />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="draft-empty">
          <AgentHero
            name={profile.name}
            avatar={profile.avatar}
            summary={profile.summary}
            {...(arriving ? { handoffId: profile.id } : {})}
          />
        </div>
      )}
      {sending?.failed && (
        <TroubleCard
          title="This message was not sent"
          detail={`${sending.failed} It is safe here: try again, or close this to change it.`}
          action="Try again"
          onAction={() => {
            const again = { ...sending, failed: undefined };
            setSending(again);
            void start(again);
          }}
          onClose={() => {
            // Back in the field to be changed, as it was before it was sent.
            useDrafts.getState().write(words, sending.text);
            setSending(undefined);
            setComposerRound((round) => round + 1);
          }}
        />
      )}
      <motion.div
        // Only one message at a time starts a chat; the next goes in the chat it starts.
        inert={Boolean(sending)}
        initial={arriving && !still ? { opacity: 0, y: 32 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.75, delay: 0.3, ease: [0.23, 1, 0.32, 1] }}
      >
        <Composer
          key={composerRound}
          draft
          draftKey={words}
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
          // Done as far as the owner can tell: the words are in the conversation already, and the
          // field empties. What is still to happen happens under them.
          send={async (text, mediaIds) => {
            const message: Sending = {
              text,
              mediaIds,
              requestKey: crypto.randomUUID(),
              startedAt: new Date().toISOString(),
            };
            setSending(message);
            void start(message);
            // The composer forgets its draft next. It stays written until the gateway has it, so
            // closing the app in that moment does not lose it.
            setTimeout(() => useDrafts.getState().write(words, text), 0);
          }}
          onSent={() => {}}
        />
      </motion.div>
    </section>
  );
}
