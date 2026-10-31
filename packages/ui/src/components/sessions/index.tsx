'use client';

import { AGENT_SESSION_CHANNEL, GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import { useEffect, useState } from 'react';
import type { Message, Session } from '../../lib/api';
import { conversationName } from '../../lib/conversation-name';
import { agentPath } from '../../lib/navigation';
import {
  useActivities,
  useAgent,
  useAgents,
  useChannels,
  useContacts,
  useProjects,
  useProviderModels,
  useSessions,
} from '../../lib/query/agent';
import { useCrew } from '../../lib/stores/crew';
import { draftKey } from '../../lib/stores/drafts';
import { sendNow } from '../../lib/stores/outbox';
import { useRefresh } from '../../lib/workspace';
import { useParams, useRouter, useSearchParams } from '../../platform/navigation';
import type { SectionActions } from '../props';
import { AgentToolbar } from './agent-toolbar';
import { Composer } from './composer';
import { ContextRing } from './context-ring';
import { ModelNames, prettyModel } from './crew';
import { CrewDrawer } from './crew-drawer';
import { ConversationDock } from './dock';
import { DraftPane } from './draft-pane';
import { GitHubDrawer, GitHubLinks } from './github';
import { History } from './history';
import { SessionListeners } from './listeners';
import { SessionModel } from './model-picker';
import { SessionObjective } from './objective';
import { SessionProtection } from './protection-menu';

const isGateway = (session: Session) => session.channel === GATEWAY_SESSION_CHANNEL;
/**
 * While a chat is on screen the panel says it was read, now and then: what arrives in it is
 * read as it arrives, and the gateway sends no notification about a chat being looked at.
 */
const READING_MS = 30_000;
/** The chat a channel's conversation is answered in, as people call it. */
const chatName = (session: Session) => (session.channel === 'telegram' ? 'Telegram' : 'WhatsApp');
const isMessaging = (session: Session) =>
  ['whatsapp', 'whatsapp-business', 'telegram'].includes(session.channel);
const isAgent = (session: Session) => session.channel === AGENT_SESSION_CHANNEL;
/** A conversation with a bar under it: a chat's composer, or a channel's settings. */
const docked = (session: Session) => isGateway(session) || isMessaging(session) || isAgent(session);

/**
 * The open conversation of an agent, whose list the sidebar draws. The conversation is the
 * address's; with none, a new chat is written in its place until the first message makes it
 * real. `?new` asks for a fresh one.
 */
export function Sessions({ api, mutate, busy }: SectionActions) {
  const profile = useAgent();
  const sessions = useSessions();
  const contacts = useContacts();
  const channels = useChannels();
  const projects = useProjects();
  const activities = useActivities();
  const profiles = useAgents();
  const router = useRouter();
  const refresh = useRefresh();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const selected = sessionId ? decodeURIComponent(sessionId) : undefined;
  const search = useSearchParams();
  // The request stays in the address while the chat is written: going back leaves it, and a
  // phone knows the draft is what is on screen. Its first message replaces it with the chat.
  const asked = search.has('new');
  const draft = !selected;
  const active = selected ? sessions.find((session) => session.id === selected) : undefined;
  const [replyTo, setReplyTo] = useState<Message>();
  useEffect(
    () =>
      setReplyTo((current) =>
        current && (current.sessionId !== selected || current.profileId !== profile.id)
          ? undefined
          : current,
      ),
    [selected, profile.id],
  );
  const following = useCrew((state) => state.following);
  const providerModels = useProviderModels();
  // Agents' models by the name their provider gives, the id read as a name when it gives none.
  const modelName = ({ providerId, modelId }: { providerId: string; modelId: string }) =>
    providerModels[providerId]?.models.find((model) => model.id === modelId)?.displayName ??
    prettyModel(modelId);
  // Bumped by a sent message, so the open history reads again instead of waiting for its poll.
  const [sent, setSent] = useState(0);
  const answered = () => {
    setSent((value) => value + 1);
    void refresh();
  };

  const onScreen = active && isGateway(active) ? active.id : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new last message is read as it arrives.
  useEffect(() => {
    if (!onScreen) return;
    // Read means in front of the owner: a window left open behind another app is not being
    // read, and what arrives there is theirs to be notified about.
    const mark = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        void api.markSessionRead(profile.id, onScreen).catch(() => {});
      }
    };
    mark();
    const timer = setInterval(mark, READING_MS);
    document.addEventListener('visibilitychange', mark);
    window.addEventListener('focus', mark);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', mark);
      window.removeEventListener('focus', mark);
    };
  }, [onScreen, active?.lastMessage?.at]);

  if (draft) {
    const project = search.get('project');
    return (
      <div className="messenger">
        <DraftPane
          // A new request starts the draft over; the idle draft keeps its words meanwhile.
          key={asked ? search.toString() : 'idle'}
          api={api}
          profile={profile}
          project={project && projects.some((item) => item.id === project) ? project : null}
          // The draft became this conversation; going back should not return to the draft.
          opened={(id) =>
            router.replace(agentPath(profile.id, `sessions/${encodeURIComponent(id)}`))
          }
          sent={answered}
          refresh={() => void refresh()}
        />
      </div>
    );
  }

  if (!active) {
    return (
      <div className="messenger">
        <section className="conversation-pane grid place-items-center px-6 text-center">
          <div className="grid max-w-sm gap-2">
            <h2 className="text-base font-semibold text-ink">This conversation is not here</h2>
            <p className="text-sm">It was deleted, or the link points to another agent.</p>
          </div>
        </section>
      </div>
    );
  }

  const contact = contacts.find(
    (item) => item.sessionId === active.id && item.profileId === profile.id,
  );
  // Where the conversation's objective stands and what it listens for, beside where it runs.
  const badges = (side: 'top' | 'bottom' = 'top') => (
    <span className="session-badges">
      {active.objective && <SessionObjective objective={active.objective} side={side} />}
      <SessionListeners api={api} profileId={profile.id} sessionId={active.id} side={side} />
    </span>
  );
  const waits = activities.find((run) => run.sessionId === active.id && run.status === 'waiting');

  return (
    <div className="messenger">
      <section
        className="conversation-pane"
        aria-label={conversationName(active, { projects, contacts, profiles })}
      >
        <ModelNames.Provider value={modelName}>
          <GitHubLinks api={api}>
            {/* The Inspector beside the conversation runs from the top of the pane. */}
            <div className="conversation-main" data-following={following ? true : undefined}>
              <div className="conversation-column">
                {/* A conversation without a bar at the bottom keeps its badges in the corner. */}
                {!docked(active) && <div className="pane-badges">{badges('bottom')}</div>}
                <div className="conversation-chat">
                  <History
                    key={active.id}
                    agent={profile}
                    agents={profiles}
                    api={api}
                    profileId={profile.id}
                    sessionId={active.id}
                    revision={sent}
                    group={active.scope === 'group' || contact?.scope === 'group'}
                    chat={isMessaging(active) ? chatName(active) : undefined}
                    empty={
                      isGateway(active)
                        ? `Write to ${profile.name} below.`
                        : 'Messages arriving through the channel show up here.'
                    }
                    initialRun={activities
                      .filter((run) => run.sessionId === active.id)
                      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
                      .at(-1)}
                    // A failed turn is retried where the panel answers the conversation itself.
                    retryRun={
                      isGateway(active) ? (run) => api.retryRun(profile.id, run.id) : undefined
                    }
                    onAnswered={answered}
                    onReply={isGateway(active) ? setReplyTo : undefined}
                  />
                  {docked(active) && (
                    <ConversationDock key={`dock-${active.id}`}>
                      {isGateway(active) ? (
                        <Composer
                          key={`composer-${active.id}`}
                          draftKey={draftKey(profile.id, active.id)}
                          name={profile.name}
                          replyTo={replyTo}
                          onCancelReply={() => setReplyTo(undefined)}
                          modelControl={
                            <>
                              <ContextRing
                                key={`composer-context-${active.id}`}
                                profileId={profile.id}
                                sessionId={active.id}
                                compact={async () => {
                                  await api.send(profile.id, active.id, '/compact');
                                  answered();
                                }}
                              />
                              <SessionProtection
                                key={`composer-protection-${active.id}`}
                                api={api}
                                profileId={profile.id}
                                session={active}
                                saved={() => void refresh()}
                              />
                              <SessionModel
                                key={`composer-model-${active.id}`}
                                api={api}
                                profileId={profile.id}
                                session={active}
                                channel={false}
                                className="composer-model-control"
                                saved={() => void refresh()}
                              />
                            </>
                          }
                          status={badges()}
                          // Writing instead of deciding declines, and the words reach the agent.
                          placeholder={
                            waits?.approval
                              ? 'Write to decline and say why…'
                              : waits
                                ? 'Answer to continue…'
                                : undefined
                          }
                          upload={(file) => api.upload(profile.id, active.id, file)}
                          // Shown in the conversation at once and sent behind it, as a messenger
                          // does: one that fails stays there to be sent again.
                          send={async (text, mediaIds, replyToId) =>
                            sendNow({
                              sessionId: active.id,
                              text,
                              mediaIds,
                              ...(replyTo
                                ? { replyTo: { id: replyTo.id, content: replyTo.content } }
                                : {}),
                              deliver: (key) =>
                                api.send(profile.id, active.id, text, mediaIds, key, replyToId),
                              delivered: answered,
                            })
                          }
                          onSent={answered}
                        />
                      ) : (
                        <AgentToolbar
                          key={`toolbar-${active.id}`}
                          api={api}
                          mutate={mutate}
                          busy={busy}
                          profileId={profile.id}
                          session={active}
                          messaging={isMessaging(active)}
                          contact={contact}
                          channels={channels}
                          badges={badges()}
                          saved={() => void refresh()}
                        />
                      )}
                    </ConversationDock>
                  )}
                </div>
              </div>
              <CrewDrawer api={api} profileId={profile.id} />
              {/* Any conversation can have its agent settle a pull request's conflicts; merging
                  belongs to the panel's own chat, as a channel's approvals are left to it. */}
              <GitHubDrawer
                api={api}
                profileId={profile.id}
                merges={isGateway(active)}
                fixConflicts={async (pull) => {
                  await api.fixGithubConflicts(profile.id, active.id, pull);
                  answered();
                }}
              />
            </div>
          </GitHubLinks>
        </ModelNames.Provider>
      </section>
    </div>
  );
}
