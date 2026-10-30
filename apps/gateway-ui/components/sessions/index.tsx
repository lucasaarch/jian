'use client';

import {
  AGENT_SESSION_CHANNEL,
  GATEWAY_SESSION_CHANNEL,
  LEARNING_SESSION_CHANNEL,
} from '@jian/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bot,
  CheckCheck,
  GraduationCap,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Terminal,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { type ComponentType, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Select } from '@/components/ui/select';
import { agentPath } from '@/lib/navigation';
import {
  useActivities,
  useAgent,
  useAgents,
  useChannels,
  useContacts,
  useProjects,
  useProviderModels,
  useSessions,
} from '@/lib/query/agent';
import { keys } from '@/lib/query/keys';
import { useCrew } from '@/lib/stores/crew';
import { useLayout } from '@/lib/stores/layout';
import { useDeleteConversation, useRefresh } from '@/lib/workspace';
import type { ProtectionMode, Run, Session } from '../../lib/api';
import { date, LOCALE } from '../../lib/format';
import type { SectionActions } from '../props';
import {
  Badge,
  Button,
  Empty,
  Field,
  IconButton,
  Modal,
  Orb,
  SearchField,
  Switch,
  TelegramLogo,
  WhatsAppLogo,
} from '../ui';
import { plainText } from '../ui/markdown';
import { Composer } from './composer';
import { CrewDrawer, ModelNames, prettyModel } from './crew';
import { ConversationDock } from './dock';
import { GitHubDrawer, GitHubLinks } from './github';
import { History } from './history';
import { SessionListeners } from './listeners';
import { SessionModel } from './model-picker';
import { SessionObjective } from './objective';
import { statusOf } from './progress';
import { ProjectSelect } from './project-select';
import { SessionProtection } from './protection-menu';

/**
 * The kinds of conversation a profile has, besides chats started in Jian and the one where it
 * looks back on its work. A channel the panel does not know reads as API.
 */
type Kind = 'whatsapp' | 'whatsapp-business' | 'telegram' | 'agent' | 'api' | 'learning';

const kinds: { kind: Kind; name: string; icon: ComponentType<{ size?: number }> }[] = [
  { kind: 'whatsapp', name: 'WhatsApp (Baileys)', icon: WhatsAppLogo },
  { kind: 'whatsapp-business', name: 'WhatsApp Business (Meta)', icon: WhatsAppLogo },
  { kind: 'telegram', name: 'Telegram', icon: TelegramLogo },
  { kind: 'agent', name: 'Agents', icon: Bot },
  { kind: 'api', name: 'API Server', icon: Terminal },
  { kind: 'learning', name: 'Learning', icon: GraduationCap },
];

const kindOf = (session: Session): Kind =>
  session.channel === LEARNING_SESSION_CHANNEL
    ? 'learning'
    : session.channel === 'whatsapp' ||
        session.channel === 'whatsapp-business' ||
        session.channel === 'telegram' ||
        session.channel === AGENT_SESSION_CHANNEL
      ? (session.channel as Kind)
      : 'api';

const isGateway = (session: Session) => session.channel === GATEWAY_SESSION_CHANNEL;
/** The chat a channel's conversation is answered in, as people call it. */
const chatName = (session: Session) => (session.channel === 'telegram' ? 'Telegram' : 'WhatsApp');
const isMessaging = (session: Session) =>
  ['whatsapp', 'whatsapp-business', 'telegram'].includes(session.channel);
/** A conversation with a bar under it: a chat's composer, or a channel's settings. */
const docked = (session: Session) =>
  isGateway(session) || isMessaging(session) || kindOf(session) === 'agent';

const openingTitle = (text: string, hasMedia: boolean) => {
  const opening = text.trim().replace(/\s+/g, ' ');
  if (!opening) return hasMedia ? 'Shared files' : 'New chat';
  return opening.length <= 60 ? opening : `${opening.slice(0, 59).trimEnd()}…`;
};

/** Today's conversations show the hour; older ones the day, as a messaging app does. */
const when = (value: string) => {
  const moment = new Date(value);

  return moment.toDateString() === new Date().toDateString()
    ? moment.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
    : moment.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' });
};

/**
 * Under a conversation's name: what the agent is doing, when it is doing something, or the last
 * thing said, on one line. What the agent itself said carries the double tick of a sent message.
 */
function Preview({ session, run }: { session: Session; run: Run | undefined }) {
  if (run) {
    const { label, state } = statusOf(run);

    return (
      <small className="conversation-preview working">
        <Orb state={state} />
        {label}
      </small>
    );
  }

  const last = session.lastMessage;

  if (!last) {
    return <small className="conversation-preview">No messages yet</small>;
  }

  return (
    <small className="conversation-preview">
      {last.role === 'assistant' && <CheckCheck size={14} aria-label="Sent by the agent" />}
      <span>{preview(last.text) || '📎'}</span>
    </small>
  );
}

/**
 * The last message as one line of words: a schedule by its name, a reply without the quote
 * above it, a reaction as the emoji, and no Markdown marks.
 */
function preview(text: string) {
  const scheduled = /^\[Scheduled: ([^\]]+)\]/.exec(text);

  if (scheduled) return `⏰ ${scheduled[1]}`;

  const learning = /^\[Learning\] ([^\n]*)/.exec(text);

  if (learning) return learning[1] ?? '';

  return plainText(
    text
      .replace(/\[Reacted (\S+) to [^\]]*\]$/, 'Reacted $1')
      .replace(/\[Replying to [^\n]*\]\n/, '')
      .replace(/\n?\[File not (opened|kept)[^\]]*\]/g, ' 📎'),
  );
}

/** Puts the chat list away or brings it back. A phone shows one or the other already. */
function ListToggle() {
  const collapsed = useLayout((state) => state.chatList);
  const toggle = useLayout((state) => state.toggle);

  return (
    <IconButton
      className="chat-list-toggle"
      aria-label={collapsed ? 'Show the chat list' : 'Hide the chat list'}
      aria-expanded={!collapsed}
      aria-controls="chat-list"
      onClick={() => toggle('chatList')}
    >
      {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
    </IconButton>
  );
}

export function Sessions({ api, mutate, busy }: SectionActions) {
  const profile = useAgent();
  const sessions = useSessions();
  const contacts = useContacts();
  const channels = useChannels();
  const projects = useProjects();
  const activities = useActivities();
  const router = useRouter();
  // The open conversation is the URL's: a link, a reload or the back button all land on it.
  const { sessionId } = useParams<{ sessionId?: string }>();
  const selected = sessionId ? decodeURIComponent(sessionId) : undefined;
  const open = (id: string | undefined, replace = false) => {
    const href = agentPath(profile.id, id ? `sessions/${encodeURIComponent(id)}` : 'sessions');

    if (replace) router.replace(href);
    else router.push(href);
  };
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState(false);
  // On a phone the list and the conversation take turns: the conversation shows while one is
  // in the URL or a new chat is being written.
  const reading = draft || Boolean(selected);
  const listCollapsed = useLayout((state) => state.chatList);
  const following = useCrew((state) => state.following);
  const providerModels = useProviderModels();
  // Agents' models by the name their provider gives, the id read as a name when it gives none.
  const modelName = ({ providerId, modelId }: { providerId: string; modelId: string }) =>
    providerModels[providerId]?.models.find((model) => model.id === modelId)?.displayName ??
    prettyModel(modelId);
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [draftMachineId, setDraftMachineId] = useState<string | null>(null);
  const [draftModel, setDraftModel] = useState<Session['model']>();
  const [draftProtection, setDraftProtection] = useState<ProtectionMode>('ask');
  const draftSession = useRef<Promise<Session> | null>(null);
  const [renaming, setRenaming] = useState<Session>();
  const [renameTitle, setRenameTitle] = useState('');
  // The channel a conversation is listed under, so one opened by its address is in view.
  const channelOf = (id: string | undefined) => {
    const session = sessions.find((item) => item.id === id);

    if (!session || isGateway(session)) return GATEWAY_SESSION_CHANNEL;

    return (
      contacts.find(
        (contact) => contact.sessionId === session.id && contact.profileId === profile.id,
      )?.channelId ??
      channels.find((channel) => channel.type === session.channel && !channel.revokedAt)?.id ??
      GATEWAY_SESSION_CHANNEL
    );
  };
  const [channelFilter, setChannelFilter] = useState(() => channelOf(selected));
  const [contextMenu, setContextMenu] = useState<{
    session: Session;
    left: number;
    top: number;
  }>();
  const menuButton = useRef<HTMLButtonElement>(null);
  // Bumped by a sent message, so the open history reads again instead of waiting for its poll.
  const [sent, setSent] = useState(0);

  // A conversation opened from elsewhere — a schedule's history, a project — while this screen
  // stays mounted: leave any unsent new chat and show the channel it belongs to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a change of address re-aims the list.
  useEffect(() => {
    if (!selected) return;
    setDraft(false);
    draftSession.current = null;
    if (sessions.some((session) => session.id === selected)) {
      setChannelFilter(channelOf(selected));
    }
  }, [selected]);

  // The machines a chat can run on, every one of them; none when the list cannot be read.
  // Shares the cache with Remote Control, through the section's own client, and is read again
  // now and then so a machine that connects or stops shows up without a reload.
  const { data: machines = [] } = useQuery({
    queryKey: keys.remoteMachines,
    queryFn: () => api.remoteMachines(),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    if (contextMenu) menuButton.current?.focus();
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('.conversation-context-menu')
      ) {
        setContextMenu(undefined);
      }
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [contextMenu]);

  const profiles = useAgents();
  const refresh = useRefresh();
  const deleteConversation = useDeleteConversation();
  // The open chat runs in another repository from its next turn.
  const moveToProject = (session: Session, projectId: string | null) =>
    void api
      .setGatewaySessionTarget(profile.id, session.id, projectId, session.remoteMachineId ?? null)
      .then(() => refresh())
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : 'The project could not be changed.'),
      );
  const ensureDraftSession = () => {
    if (!draftSession.current) {
      draftSession.current = api.createGatewaySession(profile.id, draftProjectId, draftMachineId);
    }
    return draftSession.current;
  };
  const contactOf = (session: Session) =>
    contacts.find(
      (contact) => contact.sessionId === session.id && contact.profileId === profile.id,
    );
  const peerOf = (session: Session) =>
    session.peerProfileId ? profiles.find((item) => item.id === session.peerProfileId) : undefined;
  // A person or group by the name it uses, another agent by its own, and an API conversation by
  // the title the agent gave it. The stored title of the others carries a channel prefix.
  const nameOf = (session: Session) => {
    if (isGateway(session)) {
      const project = projects.find((item) => item.id === session.projectId);
      return session.title ?? (project ? `${project.name} · New chat` : 'New chat');
    }
    const kind = kindOf(session);
    const stored = session.title?.replace(/^(Agent|WhatsApp|Telegram)\s·\s/, '');

    if (kind === 'api') return session.title ?? 'Untitled conversation';
    if (kind === 'learning') return 'What it learned';
    if (kind === 'agent') return peerOf(session)?.name ?? stored ?? 'Agent';

    return contactOf(session)?.displayName ?? stored ?? 'Unknown contact';
  };

  const lastAt = (session: Session) => session.lastMessage?.at ?? session.createdAt;
  const connectedChannels = channels.filter(
    (channel) =>
      !channel.revokedAt &&
      (channel.type !== 'whatsapp-business' || channel.whatsappBusinessStatus === 'configured'),
  );
  const channelName = (type: string) => kinds.find((item) => item.kind === type)?.name ?? type;
  const channelOptions = [
    { id: GATEWAY_SESSION_CHANNEL, name: 'Chats', icon: MessagesSquare },
    ...connectedChannels.map((channel) => ({
      id: channel.id,
      name: channelName(channel.type),
      icon: kinds.find((kind) => kind.kind === channel.type)?.icon ?? MessagesSquare,
    })),
  ].map((option) => ({
    value: option.id,
    label: option.name,
    icon: <option.icon size={16} aria-hidden="true" />,
  }));
  const matchesChannel = (session: Session) => {
    if (channelFilter === GATEWAY_SESSION_CHANNEL) return isGateway(session);
    const channel = connectedChannels.find((item) => item.id === channelFilter);
    if (!channel) return true;
    const contact = contactOf(session);
    return contact ? contact.channelId === channel.id : session.channel === channel.type;
  };
  const openContextMenu = (
    event: {
      preventDefault: () => void;
      clientX: number;
      clientY: number;
    },
    session: Session,
  ) => {
    event.preventDefault();
    if (session.channel === LEARNING_SESSION_CHANNEL) return;
    setContextMenu({
      session,
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - 200)),
      top: Math.max(8, Math.min(event.clientY, window.innerHeight - 80)),
    });
  };
  // The run at work in each conversation, which the list shows as the conversation does.
  const working = new Map(
    activities
      .filter((run) => run.status === 'queued' || run.status === 'running')
      .map((run) => [run.sessionId, run]),
  );
  const visibleSessions = sessions.filter(matchesChannel);
  const matches = (session: Session) =>
    `${nameOf(session)} ${session.lastMessage?.text ?? ''}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase());
  // Most recent conversation first, as a messaging app orders them.
  const filtered = visibleSessions
    .filter((session) => !isGateway(session) && matches(session))
    .sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
  const groups = kinds
    .map((kind) => ({ ...kind, sessions: filtered.filter((item) => kindOf(item) === kind.kind) }))
    .filter((group) => group.sessions.length);
  const gatewaySessions = visibleSessions
    .filter((session) => isGateway(session) && matches(session))
    .sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
  const gatewayGroups = projects
    .map((project) => ({
      id: project.id,
      name: project.name,
      sessions: gatewaySessions.filter((session) => session.projectId === project.id),
    }))
    .filter((group) => group.sessions.length);
  const unassignedChats = gatewaySessions.filter((session) => !session.projectId);
  const active = draft
    ? undefined
    : (visibleSessions.find((session) => session.id === selected) ??
      gatewaySessions[0] ??
      groups[0]?.sessions[0]);
  const activeContact = active && contactOf(active);

  // Where the conversation's objective stands and what it listens for, beside where it runs.
  const badges = (session: Session, side: 'top' | 'bottom' = 'top') => (
    <span className="session-badges">
      {session.objective && <SessionObjective objective={session.objective} side={side} />}
      <SessionListeners api={api} profileId={profile.id} sessionId={session.id} side={side} />
    </span>
  );

  const row = (session: Session) => (
    <button
      type="button"
      key={session.id}
      className="conversation-item"
      aria-current={active?.id === session.id ? 'true' : undefined}
      onContextMenu={(event) => openContextMenu(event, session)}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          openContextMenu(
            {
              preventDefault: () => {},
              clientX: rect.left,
              clientY: rect.bottom,
            },
            session,
          );
        }
      }}
      onClick={() => {
        setDraft(false);
        draftSession.current = null;
        open(session.id);
      }}
    >
      <span className="conversation-text">
        <strong>{nameOf(session)}</strong>
        <Preview session={session} run={working.get(session.id)} />
      </span>
      <time dateTime={lastAt(session)} title={date(lastAt(session))}>
        {when(lastAt(session))}
      </time>
    </button>
  );

  return (
    <div
      className="messenger"
      data-reading={reading}
      data-list={listCollapsed ? 'collapsed' : 'open'}
    >
      <aside id="chat-list" className="conversation-list" aria-label="Conversations">
        <header>
          <div className="chat-channel-bar">
            <div className="chat-channel-select">
              <Select
                aria-label="Channel"
                value={channelFilter}
                options={channelOptions}
                onValueChange={(channelId) => {
                  setChannelFilter(channelId);
                  setDraft(false);
                  draftSession.current = null;
                  if (selected) open(undefined);
                }}
              />
            </div>
            <IconButton
              size="control"
              variant="primary"
              aria-label="New chat"
              disabled={busy || draft}
              onClick={() => {
                setChannelFilter(GATEWAY_SESSION_CHANNEL);
                if (selected) open(undefined);
                setDraft(true);
                setDraftProjectId(null);
                setDraftMachineId(null);
                setDraftModel(undefined);
                setDraftProtection('ask');
                draftSession.current = null;
              }}
            >
              <Plus size={18} />
            </IconButton>
          </div>
          <SearchField
            aria-label="Search conversations"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </header>
        <div className="conversation-scroll">
          {unassignedChats.length > 0 && (
            <section>
              <h2>
                General
                <span>{unassignedChats.length}</span>
              </h2>
              {unassignedChats.map(row)}
            </section>
          )}
          {gatewayGroups.map((group) => (
            <section key={group.id}>
              <h2>
                {group.name}
                <span>{group.sessions.length}</span>
              </h2>
              {group.sessions.map(row)}
            </section>
          ))}
          {groups.map(({ kind, name, icon: Icon, sessions }) => (
            <section key={kind}>
              <h2>
                <Icon size={14} />
                {name}
                <span>{sessions.length}</span>
              </h2>
              {sessions.map(row)}
            </section>
          ))}
          {!groups.length && !gatewayGroups.length && !unassignedChats.length && (
            <p className="conversation-none">
              {visibleSessions.length
                ? 'Nothing matches that search.'
                : 'No conversations in this channel.'}
            </p>
          )}
        </div>
      </aside>
      {draft && (
        <section className="conversation-pane" aria-label="New chat">
          <header>
            <ListToggle />
            <IconButton
              className="conversation-back"
              aria-label="Back to the conversations"
              onClick={() => {
                setDraft(false);
                draftSession.current = null;
              }}
            >
              <ArrowLeft size={18} />
            </IconButton>
            <div className="grow">
              <h2>New chat</h2>
            </div>
          </header>
          <div className="draft-empty">
            <Empty title="Start a conversation">Send a message to create your chat.</Empty>
          </div>
          <Composer
            key="draft-composer"
            draft
            machines={machines}
            remoteMachineId={draftMachineId}
            projectControl={
              <ProjectSelect
                api={api}
                profileId={profile.id}
                projects={projects}
                projectId={draftProjectId}
                onChange={setDraftProjectId}
              />
            }
            onMachineChange={setDraftMachineId}
            modelControl={
              <>
                <SessionProtection
                  api={api}
                  profileId={profile.id}
                  draft={draftProtection}
                  onDraftChange={setDraftProtection}
                />
                <SessionModel
                  api={api}
                  profileId={profile.id}
                  channel={false}
                  draftModel={draftModel}
                  onDraftChange={setDraftModel}
                  className="composer-model-control"
                  saved={() => void refresh()}
                />
              </>
            }
            name={profile.name}
            upload={async (file) => {
              const session = await ensureDraftSession();
              return api.upload(profile.id, session.id, file);
            }}
            send={async (text, mediaIds) => {
              const session = await ensureDraftSession();
              if (draftModel) await api.setSessionModel(profile.id, session.id, draftModel);
              // A conversation starts asking first; only a different choice needs saving.
              if (draftProtection !== 'ask') {
                await api.setSessionProtection(profile.id, session.id, draftProtection);
              }
              await api.renameSession(
                profile.id,
                session.id,
                openingTitle(text, mediaIds.length > 0),
              );
              await api.send(profile.id, session.id, text, mediaIds);
              draftSession.current = null;
              setDraft(false);
              // The draft became this conversation; going back should not return to the draft.
              open(session.id, true);
            }}
            onSent={() => {
              setSent((value) => value + 1);
              void refresh();
            }}
          />
        </section>
      )}
      {active && (
        <section className="conversation-pane" aria-label={nameOf(active)}>
          <ModelNames.Provider value={modelName}>
            <GitHubLinks api={api}>
              {/* The Inspector beside the conversation runs from the top of the pane: the
                  conversation's header belongs to its column, not across both. */}
              <div className="conversation-main" data-following={following ? true : undefined}>
                <div className="conversation-column">
                  <header>
                    <ListToggle />
                    <IconButton
                      className="conversation-back"
                      aria-label="Back to the conversations"
                      onClick={() => open(undefined)}
                    >
                      <ArrowLeft size={18} />
                    </IconButton>
                    <div className="grow">
                      <h2>{nameOf(active)}</h2>
                      {/* A channel's conversation says where it comes from and with whom; a chat of the
                        panel's own needs no line saying so. */}
                      {!isGateway(active) && (
                        <small>
                          {kinds.find((item) => item.kind === kindOf(active))?.name}
                          {active.scope === 'group' || activeContact?.scope === 'group'
                            ? ' · Group'
                            : ''}
                          {activeContact && activeContact.displayName !== activeContact.actorId
                            ? ` · ${activeContact.actorId}`
                            : ''}
                        </small>
                      )}
                    </div>
                    {/* A conversation without a bar at the bottom keeps its badges up here. */}
                    {!docked(active) && badges(active, 'bottom')}
                  </header>
                  <div className="conversation-chat">
                    <History
                      key={active.id}
                      api={api}
                      profileId={profile.id}
                      sessionId={active.id}
                      revision={sent}
                      group={active.scope === 'group' || activeContact?.scope === 'group'}
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
                      onAnswered={() => {
                        setSent((value) => value + 1);
                        void refresh();
                      }}
                    />
                    {docked(active) && (
                      <ConversationDock key={`dock-${active.id}`}>
                        {isGateway(active) && (
                          <Composer
                            key={`composer-${active.id}`}
                            name={profile.name}
                            machines={machines}
                            remoteMachineId={active.remoteMachineId ?? null}
                            projectControl={
                              <ProjectSelect
                                api={api}
                                profileId={profile.id}
                                projects={projects}
                                projectId={active.projectId ?? null}
                                onChange={(projectId) => moveToProject(active, projectId)}
                              />
                            }
                            onMachineChange={(machineId) =>
                              void api
                                .setGatewaySessionTarget(
                                  profile.id,
                                  active.id,
                                  active.projectId ?? null,
                                  machineId,
                                )
                                .then(() => refresh())
                                .catch((error: unknown) =>
                                  toast.error(
                                    error instanceof Error
                                      ? error.message
                                      : 'The machine could not be changed.',
                                  ),
                                )
                            }
                            modelControl={
                              <>
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
                            status={badges(active)}
                            placeholder={(() => {
                              const waits = activities.find(
                                (run) => run.sessionId === active.id && run.status === 'waiting',
                              );
                              // Writing instead of deciding declines, and the words reach the agent.
                              if (waits?.approval) return 'Write to decline and say why…';
                              return waits ? 'Answer to continue…' : undefined;
                            })()}
                            upload={(file) => api.upload(profile.id, active.id, file)}
                            send={(text, mediaIds) =>
                              api.send(profile.id, active.id, text, mediaIds)
                            }
                            onSent={() => {
                              setSent((value) => value + 1);
                              void refresh();
                            }}
                          />
                        )}
                        {(isMessaging(active) || kindOf(active) === 'agent') && (
                          // Where a chat has its composer, a channel's conversation has its settings:
                          // whether the agent answers this contact, and on which model.
                          <section
                            className="agent-toolbar"
                            aria-label="Agent settings for this conversation"
                          >
                            <div className="agent-toolbar-box">
                              <SessionProtection
                                key={`toolbar-protection-${active.id}`}
                                api={api}
                                profileId={profile.id}
                                session={active}
                                align="start"
                                saved={() => void refresh()}
                              />
                              <SessionModel
                                key={`toolbar-model-${active.id}`}
                                api={api}
                                profileId={profile.id}
                                session={active}
                                channel={isMessaging(active)}
                                className="composer-model-control"
                                menuAlign="start"
                                saved={() => void refresh()}
                              />
                              <span className="grow" />
                              {badges(active)}
                              {isMessaging(active) &&
                                activeContact &&
                                channels.some(
                                  (channel) =>
                                    channel.id === activeContact.channelId &&
                                    channel.enabled === false,
                                ) && <Badge tone="warn">Channel paused</Badge>}
                              {activeContact && activeContact.status !== 'approved' && (
                                <Badge>Contact {activeContact.status}</Badge>
                              )}
                              {isMessaging(active) && activeContact && (
                                <div className="agent-toolbar-switch">
                                  <span aria-hidden="true">
                                    AI<span className="agent-toolbar-switch-word"> replies</span>
                                  </span>
                                  <Switch
                                    label={`AI replies for ${activeContact.displayName ?? activeContact.actorId}`}
                                    checked={activeContact.aiEnabled ?? true}
                                    disabled={busy}
                                    onChange={(aiEnabled) =>
                                      void mutate(
                                        () =>
                                          api.updateContact(profile.id, activeContact.id, {
                                            aiEnabled,
                                          }),
                                        aiEnabled
                                          ? 'AI replies are on for this contact. Messages paused before are not replayed.'
                                          : 'AI replies are off for this contact, queued replies included.',
                                      )
                                    }
                                  />
                                </div>
                              )}
                            </div>
                          </section>
                        )}
                      </ConversationDock>
                    )}
                  </div>
                </div>
                <CrewDrawer api={api} profileId={profile.id} />
                {/* Merging and asking for a fix belong to the panel's own chat; a channel's
                  conversation reads the pull request only, as its approvals are left to it. */}
                <GitHubDrawer
                  api={api}
                  profileId={profile.id}
                  send={
                    isGateway(active)
                      ? (text) => api.send(profile.id, active.id, text, [])
                      : undefined
                  }
                  onSent={() => {
                    setSent((value) => value + 1);
                    void refresh();
                  }}
                />
              </div>
            </GitHubLinks>
          </ModelNames.Provider>
        </section>
      )}
      {!active && !draft && (
        <section className="conversation-pane">
          {listCollapsed && (
            <header>
              <ListToggle />
            </header>
          )}
          <div className="draft-empty">
            <Empty title="No conversations here">Choose a conversation or create a new chat.</Empty>
          </div>
        </section>
      )}
      {contextMenu && (
        <div
          className="conversation-context-menu"
          role="menu"
          aria-label="Conversation actions"
          style={{ left: contextMenu.left, top: contextMenu.top }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setContextMenu(undefined);
          }}
        >
          {isGateway(contextMenu.session) && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setRenameTitle(contextMenu.session.title ?? nameOf(contextMenu.session));
                setRenaming(contextMenu.session);
                setContextMenu(undefined);
              }}
            >
              Rename conversation
            </button>
          )}
          <button
            ref={menuButton}
            type="button"
            role="menuitem"
            data-danger="true"
            onClick={() => {
              const target = contextMenu.session;
              setContextMenu(undefined);
              void deleteConversation(target.id).then((deleted) => {
                if (deleted && selected === target.id) open(undefined, true);
              });
            }}
          >
            Delete conversation
          </button>
        </div>
      )}
      {renaming && (
        <Modal
          title="Rename conversation"
          description="Choose a title for this chat."
          close={() => setRenaming(undefined)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRenaming(undefined)}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="rename-conversation-form"
                busy={busy}
                disabled={!renameTitle.trim()}
              >
                Save
              </Button>
            </>
          }
        >
          <form
            id="rename-conversation-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!renaming || !renameTitle.trim()) return;
              void (async () => {
                const saved = await mutate(
                  () => api.renameSession(profile.id, renaming.id, renameTitle.trim()),
                  'Conversation renamed.',
                );
                if (saved) {
                  setRenaming(undefined);
                  await refresh();
                }
              })();
            }}
          >
            <Field label="Conversation title">
              <input
                value={renameTitle}
                maxLength={160}
                autoComplete="off"
                onChange={(event) => setRenameTitle(event.target.value)}
                // biome-ignore lint/a11y/noAutofocus: The dialog opens to edit this title.
                autoFocus
              />
            </Field>
          </form>
        </Modal>
      )}
    </div>
  );
}
