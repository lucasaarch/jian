'use client';

import {
  ArrowLeft,
  Bot,
  CheckCheck,
  LayoutDashboard,
  MessageSquare,
  Search,
  Send,
  Smartphone,
  Terminal,
} from 'lucide-react';
import { useState } from 'react';
import type { Contact, Session } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Empty, Face, Orb } from '../ui';
import { History } from './history';

const channelNames: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  api: 'API',
  panel: 'Panel',
  web: 'Panel (legacy)',
  agent: 'Agents',
};

const channelIcons: Record<string, typeof Bot> = {
  whatsapp: Smartphone,
  telegram: Send,
  api: Terminal,
  agent: Bot,
  panel: LayoutDashboard,
  web: LayoutDashboard,
};

/** Channels in the order people reach the agent through them; anything else after. */
const channelOrder = ['whatsapp', 'telegram', 'api', 'agent', 'panel', 'web'];

/** Today's conversations show the hour; older ones the day, as a messaging app does. */
const when = (value: string) => {
  const moment = new Date(value);

  return moment.toDateString() === new Date().toDateString()
    ? moment.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : moment.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
};

/**
 * The face of a conversation: the picture the contact or group uses on its channel, their
 * initials when it has none, and a symbol for a conversation that is no person at all.
 */
function ConversationAvatar({ session, contact }: { session: Session; contact?: Contact }) {
  if (!contact?.avatar && !contact && ['api', 'panel', 'web'].includes(session.channel)) {
    return (
      <span className="conversation-avatar symbol" aria-hidden="true">
        <Terminal size={18} />
      </span>
    );
  }

  if (session.peerProfileId) {
    return (
      <span className="conversation-avatar symbol" aria-hidden="true">
        <Bot size={18} />
      </span>
    );
  }

  return (
    <Face
      name={contact?.displayName ?? session.title ?? '?'}
      picture={contact?.avatar}
      className="conversation-avatar"
    />
  );
}

/**
 * Under a conversation's name: what the agent is doing, when it is doing something, or the last
 * thing said, on one line. What the agent itself said carries the double tick of a sent message.
 */
function Preview({ session, working }: { session: Session; working: boolean }) {
  if (working) {
    return (
      <small className="conversation-preview working">
        <Orb />
        Processing…
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
      <span>{last.text || '📎'}</span>
    </small>
  );
}

export function Sessions({
  profile,
  data,
  api,
  initialSession,
}: SectionProps & { initialSession?: string }) {
  const [selected, setSelected] = useState(initialSession);
  // On a phone the list and the conversation take turns; this is which one is showing.
  const [reading, setReading] = useState(Boolean(initialSession));
  const [query, setQuery] = useState('');
  // One channel at a time: conversations from different places never share a list.
  const [tab, setTab] = useState<string>();

  const contactOf = (session: Session) =>
    data.contacts.find((contact) => contact.sessionId === session.id);
  const nameOf = (session: Session) =>
    contactOf(session)?.displayName ?? session.title ?? 'Untitled conversation';

  const lastAt = (session: Session) => session.lastMessage?.at ?? session.createdAt;
  const working = new Set(
    data.activities
      .filter((run) => run.status === 'queued' || run.status === 'running')
      .map((run) => run.sessionId),
  );
  // Most recent conversation first, as a messaging app orders them.
  const recent = [...data.sessions].sort((a, b) => lastAt(b).localeCompare(lastAt(a)));
  const channels = [...new Set(recent.map((session) => session.channel))].sort(
    (a, b) =>
      ((channelOrder.indexOf(a) + 100) % 100) - ((channelOrder.indexOf(b) + 100) % 100) ||
      a.localeCompare(b),
  );
  const opened = data.sessions.find((session) => session.id === selected);
  // The open conversation's channel, else the channel where something happened last.
  const current = tab ?? opened?.channel ?? recent[0]?.channel;
  const filtered = recent.filter(
    (session) =>
      session.channel === current &&
      `${nameOf(session)} ${session.title ?? ''} ${session.lastMessage?.text ?? ''}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const active = opened ?? filtered[0];
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

  return (
    <div className="messenger" data-reading={reading}>
      <aside className="conversation-list" aria-label="Conversations by channel">
        <header>
          <h1>Sessions</h1>
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
        <div className="channel-tabs" role="tablist" aria-label="Channels">
          {channels.map((kind) => {
            const Icon = channelIcons[kind] ?? MessageSquare;
            const count = recent.filter((session) => session.channel === kind).length;
            const busy = recent.some(
              (session) => session.channel === kind && working.has(session.id),
            );

            return (
              <button
                type="button"
                role="tab"
                key={kind}
                aria-selected={kind === current}
                onClick={() => {
                  setTab(kind);
                  setSelected(undefined);
                }}
              >
                <Icon size={15} aria-hidden="true" />
                {channelNames[kind] ?? kind}
                <span className="channel-count">{count}</span>
                {busy && (
                  <span className="channel-busy">
                    <span className="sr-only">An answer is being written</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="conversation-scroll" role="tabpanel">
          {filtered.map((session) => {
            const contact = contactOf(session);

            return (
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
                <ConversationAvatar session={session} {...(contact ? { contact } : {})} />
                <span className="conversation-text">
                  <strong>{nameOf(session)}</strong>
                  <Preview session={session} working={working.has(session.id)} />
                </span>
                <time dateTime={lastAt(session)} title={date(lastAt(session))}>
                  {when(lastAt(session))}
                </time>
              </button>
            );
          })}
          {!filtered.length && <p className="conversation-none">Nothing matches that search.</p>}
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
              {...(activeContact ? { contact: activeContact } : {})}
            />
            <div className="grow">
              <h2>{nameOf(active)}</h2>
              <small>
                {channelNames[active.channel] ?? active.channel}
                {activeContact?.scope === 'group' ? ' · Group' : ''}
                {activeContact && activeContact.displayName !== activeContact.actorId
                  ? ` · ${activeContact.actorId}`
                  : ''}
              </small>
            </div>
          </header>
          <History
            key={active.id}
            api={api}
            profileId={profile.id}
            sessionId={active.id}
            initialRun={data.activities
              .filter((run) => run.sessionId === active.id)
              .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
              .at(-1)}
          />
        </section>
      )}
    </div>
  );
}
