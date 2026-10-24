'use client';

import {
  AGENT_SESSION_CHANNEL,
  GATEWAY_SESSION_CHANNEL,
  LEARNING_SESSION_CHANNEL,
} from '@jian/contracts';
import {
  ArrowLeft,
  Bot,
  CheckCheck,
  GraduationCap,
  Search,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react';
import { type ComponentType, useState } from 'react';
import type { Contact, Profile, Run, Session } from '../../lib/api';
import { date, LOCALE } from '../../lib/format';
import { useWorkspace } from '../../lib/workspace';
import type { SectionProps } from '../props';
import { Badge, Empty, Face, Orb, Switch, TelegramLogo, WhatsAppLogo } from '../ui';
import { plainText } from '../ui/markdown';
import { Composer } from './composer';
import { History } from './history';
import { SessionListeners } from './listeners';
import { SessionModel } from './model-picker';
import { statusOf } from './progress';

const objectiveTone = {
  open: 'good',
  blocked: 'warn',
  done: 'neutral',
  cancelled: 'neutral',
} as const;

const objectiveLabel = {
  open: 'Objective open',
  blocked: 'Objective blocked',
  done: 'Objective done',
  cancelled: 'Objective cancelled',
} as const;

/**
 * The kinds of conversation a profile has, besides the gateway one pinned above them, and last
 * the one where it looks back on its work. A channel the panel does not know, such as a
 * session opened through the API, reads as API.
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
const isMessaging = (session: Session) =>
  ['whatsapp', 'whatsapp-business', 'telegram'].includes(session.channel);

/** Today's conversations show the hour; older ones the day, as a messaging app does. */
const when = (value: string) => {
  const moment = new Date(value);

  return moment.toDateString() === new Date().toDateString()
    ? moment.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
    : moment.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit' });
};

/**
 * The face of a conversation: this profile's own picture on the gateway one, the other agent's, the picture the
 * contact or group uses on its channel, or a symbol for an API conversation, which has no one
 * on the other side to show.
 */
function ConversationAvatar({
  session,
  name,
  contact,
  peer,
  self,
}: {
  session: Session;
  name: string;
  contact?: Contact | undefined;
  peer?: Profile | undefined;
  self: Profile;
}) {
  if (isGateway(session)) {
    return <Face name={name} picture={self.avatar ?? undefined} className="conversation-avatar" />;
  }

  const kind = kindOf(session);

  if (kind === 'api' || kind === 'learning') {
    return (
      <span className="conversation-avatar symbol" aria-hidden="true">
        {kind === 'api' ? <Terminal size={18} /> : <GraduationCap size={18} />}
      </span>
    );
  }

  return (
    <Face
      name={name}
      picture={(kind === 'agent' ? peer?.avatar : contact?.avatar) ?? undefined}
      className="conversation-avatar"
    />
  );
}

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

export function Sessions({
  profile,
  data,
  api,
  initialSession,
  mutate,
  busy,
}: SectionProps & { initialSession?: string }) {
  const [selected, setSelected] = useState(initialSession);
  // On a phone the list and the conversation take turns; this is which one is showing.
  const [reading, setReading] = useState(Boolean(initialSession));
  const [query, setQuery] = useState('');
  // Bumped by a sent message, so the open history reads again instead of waiting for its poll.
  const [sent, setSent] = useState(0);

  const { profiles, refresh } = useWorkspace();
  const contactOf = (session: Session) =>
    data.contacts.find(
      (contact) => contact.sessionId === session.id && contact.profileId === profile.id,
    );
  const peerOf = (session: Session) =>
    session.peerProfileId ? profiles.find((item) => item.id === session.peerProfileId) : undefined;
  // A person or group by the name it uses, another agent by its own, and an API conversation by
  // the title the agent gave it. The stored title of the others carries a channel prefix.
  const nameOf = (session: Session) => {
    if (isGateway(session)) return profile.name;
    const kind = kindOf(session);
    const stored = session.title?.replace(/^(Agent|WhatsApp|Telegram)\s·\s/, '');

    if (kind === 'api') return session.title ?? 'Untitled conversation';
    if (kind === 'learning') return 'What it learned';
    if (kind === 'agent') return peerOf(session)?.name ?? stored ?? 'Agent';

    return contactOf(session)?.displayName ?? stored ?? 'Unknown contact';
  };

  const lastAt = (session: Session) => session.lastMessage?.at ?? session.createdAt;
  // The run at work in each conversation, which the list shows as the conversation does.
  const working = new Map(
    data.activities
      .filter((run) => run.status === 'queued' || run.status === 'running')
      .map((run) => [run.sessionId, run]),
  );
  const gateway = data.sessions.find(isGateway);
  const matches = (session: Session) =>
    `${nameOf(session)} ${session.lastMessage?.text ?? ''}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase());
  // Most recent conversation first, as a messaging app orders them.
  const filtered = data.sessions
    .filter((session) => !isGateway(session) && matches(session))
    .sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
  const groups = kinds
    .map((kind) => ({ ...kind, sessions: filtered.filter((item) => kindOf(item) === kind.kind) }))
    .filter((group) => group.sessions.length);
  const pinned = gateway && matches(gateway) ? gateway : undefined;
  const active =
    data.sessions.find((session) => session.id === selected) ?? gateway ?? groups[0]?.sessions[0];
  const activeContact = active && contactOf(active);

  if (!data.sessions.length) {
    return (
      <div className="messenger empty-state">
        <Empty title="No conversations yet">
          Conversations started through a channel or the API are recorded here.
        </Empty>
      </div>
    );
  }

  const row = (session: Session) => (
    <button
      type="button"
      key={session.id}
      className="conversation-item"
      aria-current={active?.id === session.id ? 'true' : undefined}
      onClick={() => {
        setSelected(session.id);
        setReading(true);
      }}
    >
      <ConversationAvatar
        session={session}
        name={nameOf(session)}
        contact={contactOf(session)}
        peer={peerOf(session)}
        self={profile}
      />
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
    <div className="messenger" data-reading={reading}>
      <aside className="conversation-list" aria-label="Conversations">
        <header>
          <h1>Chats</h1>
          <div className="search-field">
            <Search size={16} />
            <input
              aria-label="Search conversations"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </header>
        <div className="conversation-scroll">
          {pinned && <section className="conversation-pinned">{row(pinned)}</section>}
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
          {!pinned && !groups.length && (
            <p className="conversation-none">Nothing matches that search.</p>
          )}
        </div>
      </aside>
      {active && (
        <section className="conversation-pane" aria-label={nameOf(active)}>
          <header>
            <button
              type="button"
              className="icon-button conversation-back"
              aria-label="Back to the conversations"
              onClick={() => setReading(false)}
            >
              <ArrowLeft size={18} />
            </button>
            <ConversationAvatar
              session={active}
              name={nameOf(active)}
              contact={activeContact}
              peer={peerOf(active)}
              self={profile}
            />
            <div className="grow">
              <h2>{nameOf(active)}</h2>
              <small>
                {isGateway(active)
                  ? 'Gateway'
                  : kinds.find((item) => item.kind === kindOf(active))?.name}
                {active.scope === 'group' || activeContact?.scope === 'group' ? ' · Group' : ''}
                {activeContact && activeContact.displayName !== activeContact.actorId
                  ? ` · ${activeContact.actorId}`
                  : ''}
              </small>
              {active.objective && (
                <p className="session-objective">
                  <Badge tone={objectiveTone[active.objective.status]} dot={false}>
                    {objectiveLabel[active.objective.status]}
                  </Badge>
                  <span title={active.objective.text}>
                    {active.objective.text.length > 120
                      ? `${active.objective.text.slice(0, 117)}…`
                      : active.objective.text}
                  </span>
                  {active.objective.status === 'blocked' && active.objective.note ? (
                    <span className="session-objective-note" title={active.objective.note}>
                      {active.objective.note}
                    </span>
                  ) : null}
                </p>
              )}
              {active.channel === 'whatsapp-business' &&
                activeContact?.type === 'whatsapp-business' && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span>{activeContact.aiEnabled === false ? 'AI paused' : 'AI replies'}</span>
                    <Switch
                      label={`AI replies for ${activeContact.displayName ?? activeContact.actorId}`}
                      checked={activeContact.aiEnabled ?? true}
                      disabled={busy}
                      onChange={(aiEnabled) =>
                        void mutate(
                          () => api.updateContact(profile.id, activeContact.id, { aiEnabled }),
                          aiEnabled
                            ? 'AI enabled for this chat. Approval and channel automation still apply; no replay.'
                            : 'AI paused for this chat, including queued replies.',
                        )
                      }
                    />
                    {data.channels.some(
                      (channel) =>
                        channel.id === activeContact.channelId &&
                        channel.profileId === profile.id &&
                        channel.enabled === false,
                    ) && <Badge tone="warn">Channel automation paused</Badge>}
                    {activeContact.status !== 'approved' && (
                      <Badge>Contact {activeContact.status}</Badge>
                    )}
                    <p className="w-full text-xs text-muted">
                      Separate from approval and channel automation. Paused messages are never
                      replayed; queued replies stop. A request already in flight may finish.
                    </p>
                  </div>
                )}
              <SessionListeners api={api} profileId={profile.id} sessionId={active.id} />
            </div>
            {kindOf(active) !== 'learning' && (
              <>
                <div className="session-model-desktop">
                  <SessionModel
                    key={`model-desktop-${active.id}`}
                    api={api}
                    profileId={profile.id}
                    session={active}
                    data={data}
                    channel={isMessaging(active)}
                    saved={() => void refresh()}
                  />
                </div>
                <details key={`model-mobile-${active.id}`} className="session-model-mobile">
                  <summary className="icon-button" aria-label="Chat model settings">
                    <SlidersHorizontal size={18} />
                  </summary>
                  <div className="session-model-mobile-panel">
                    <SessionModel
                      api={api}
                      profileId={profile.id}
                      session={active}
                      data={data}
                      channel={isMessaging(active)}
                      saved={() => void refresh()}
                    />
                  </div>
                </details>
              </>
            )}
          </header>
          <History
            key={active.id}
            api={api}
            profileId={profile.id}
            sessionId={active.id}
            revision={sent}
            group={active.scope === 'group' || activeContact?.scope === 'group'}
            empty={
              isGateway(active)
                ? `Write to ${profile.name} below.`
                : 'Messages arriving through the channel show up here.'
            }
            initialRun={data.activities
              .filter((run) => run.sessionId === active.id)
              .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
              .at(-1)}
            onAnswered={() => {
              setSent((value) => value + 1);
              void refresh();
            }}
          />
          {isGateway(active) && (
            <Composer
              key={`composer-${active.id}`}
              name={profile.name}
              sessionId={active.id}
              placeholder={
                data.activities.some(
                  (run) => run.sessionId === active.id && run.status === 'waiting',
                )
                  ? 'Answer to continue…'
                  : undefined
              }
              upload={(file) => api.upload(profile.id, active.id, file)}
              send={(text, mediaIds) => api.send(profile.id, active.id, text, mediaIds)}
              createVoiceToken={(sessionId) => api.createVoiceToken(profile.id, sessionId)}
              executeVoiceTool={async (name, args) => {
                if (name === 'read_recent_conversation') {
                  if (args && typeof args === 'object' && Object.keys(args).length) {
                    throw new Error('Invalid arguments');
                  }
                  const messages = await api.messages(profile.id, active.id);
                  return messages.slice(-20).map(({ role, content }) => ({
                    role,
                    content: content.slice(0, 1200),
                  }));
                }
                if (name !== 'delegate_to_jian' || !args || typeof args !== 'object') {
                  throw new Error('Unsupported voice tool');
                }
                const task = (args as { task?: unknown }).task;
                if (
                  typeof task !== 'string' ||
                  !task.trim() ||
                  task.length > 4000 ||
                  Object.keys(args).some((key) => key !== 'task')
                ) {
                  throw new Error('Invalid task');
                }
                const submitted = await api.send(
                  profile.id,
                  active.id,
                  `[Live voice task]\n${task.trim()}`,
                );
                for (let attempt = 0; attempt < 120; attempt++) {
                  const run = await api.run(profile.id, submitted.id);
                  if (run.status === 'completed')
                    return (run.output ?? 'Task completed.').slice(0, 6000);
                  if (['failed', 'cancelled', 'interrupted'].includes(run.status))
                    return run.error ?? `Task ${run.status}.`;
                  if (run.status === 'waiting')
                    return 'Jian needs the owner to answer a question in the conversation.';
                  await new Promise((resolve) => setTimeout(resolve, 1000));
                }
                return 'Jian is still working; check the conversation for its result.';
              }}
              onSent={() => {
                setSent((value) => value + 1);
                void refresh();
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}
