'use client';

import { ArrowLeft, Bot, Search, Terminal } from 'lucide-react';
import { useState } from 'react';
import type { Contact, Session } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Empty, Face } from '../ui';
import { History } from './history';

const channelNames: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  api: 'API',
  panel: 'Panel',
  web: 'Panel (legacy)',
  agent: 'Other agents',
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

  const contactOf = (session: Session) =>
    data.contacts.find((contact) => contact.sessionId === session.id);
  const nameOf = (session: Session) =>
    contactOf(session)?.displayName ?? session.title ?? 'Untitled conversation';

  const filtered = [...data.sessions]
    .filter((session) =>
      `${nameOf(session)} ${session.title ?? ''} ${channelNames[session.channel] ?? session.channel}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const channels = [...new Set(filtered.map((session) => session.channel))].sort(
    (a, b) =>
      ((channelOrder.indexOf(a) + 100) % 100) - ((channelOrder.indexOf(b) + 100) % 100) ||
      a.localeCompare(b),
  );
  const first = channels
    .map((kind) => filtered.find((session) => session.channel === kind))
    .find(Boolean);
  const active = data.sessions.find((session) => session.id === selected) ?? first;
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
        <div className="conversation-scroll">
          {channels.map((kind) => {
            const group = filtered.filter((session) => session.channel === kind);

            return (
              <section key={kind}>
                <h2>
                  {channelNames[kind] ?? kind}
                  <span>{group.length}</span>
                </h2>
                {group.map((session) => {
                  const contact = contactOf(session);
                  const current = active?.id === session.id;

                  return (
                    <button
                      type="button"
                      key={session.id}
                      className="conversation-item"
                      aria-current={current ? 'true' : undefined}
                      onClick={() => {
                        setSelected(session.id);
                        setReading(true);
                      }}
                    >
                      <ConversationAvatar session={session} {...(contact ? { contact } : {})} />
                      <span className="conversation-text">
                        <strong>{nameOf(session)}</strong>
                        <small>
                          {contact?.scope === 'group'
                            ? 'Group'
                            : contact && contact.displayName !== contact.actorId
                              ? contact.actorId
                              : (session.summary?.slice(0, 80) ?? 'Conversation')}
                        </small>
                      </span>
                      <time dateTime={session.createdAt} title={date(session.createdAt)}>
                        {when(session.createdAt)}
                      </time>
                    </button>
                  );
                })}
              </section>
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
