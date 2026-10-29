'use client';

import { ShieldOff, UserCheck, UserX } from 'lucide-react';
import { useAgent, useContacts, useGroups } from '@/lib/query/agent';
import type { Channel, Contact } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionActions } from '../props';
import { Badge, Button, Face } from '../ui';
import { kinds } from './kinds';

const agents = (count: number) => (count === 1 ? '1 agent' : `${count} agents`);

/**
 * Who this channel reaches for the profile: its groups and its people. A request waiting on the
 * owner comes first, with what it said. Revoking stops the agent answering there and keeps the
 * conversation; approving again restores it.
 */
export function Conversations({
  channel,
  api,
  mutate,
  busy,
}: SectionActions & { channel: Channel }) {
  const profile = useAgent();
  const contacts = useContacts();
  // The groups the gateway knows, with their members; distinct from this channel's group contacts.
  const rooms = useGroups();
  // Waiting first, then approved, then revoked: what needs a decision is never below the fold.
  const order = { pending: 0, approved: 1, blocked: 2 } as const;
  const mine = contacts
    .filter((contact) => contact.channelId === channel.id)
    .sort((a, b) => order[a.status] - order[b.status]);
  const groups = mine.filter((contact) => contact.scope === 'group');
  const people = mine.filter((contact) => contact.scope !== 'group');

  const approve = (contact: Contact, name: string) =>
    mutate(
      () => api.approveContact(profile.id, contact.id),
      channel.enabled === false || contact.aiEnabled === false
        ? `${name} approved. The agent stays quiet there until the channel and the contact are on again.`
        : contact.status === 'pending'
          ? channel.type === 'whatsapp-business'
            ? `${name} approved. Replies still require an open customer-service window.`
            : `${name} approved. What they wrote went to the agent.`
          : `${name} approved again.`,
    );
  const refuse = (contact: Contact, name: string) =>
    mutate(
      () => api.blockContact(profile.id, contact.id),
      contact.status === 'pending'
        ? `${name} declined.`
        : `${name} revoked. The agent no longer answers there.`,
    );

  // A request is a decision, not a row: it gets room for who wrote, what they said, and the
  // two answers, with the one that approves last and strongest.
  const request = (contact: Contact, detail: string) => {
    const name = contact.displayName ?? contact.actorId;
    const channelName = kinds.find((kind) => kind.type === contact.type)?.name;

    return (
      <article className="request-card" key={contact.id}>
        <header>
          <Face name={name} picture={contact.avatar} className="request-face" />
          <div className="grow">
            <h4>
              {name}
              <Badge tone="accent">Pending</Badge>
            </h4>
            <small>
              {channelName}
              {detail !== name && ` · ${detail}`}
            </small>
          </div>
          <time dateTime={contact.createdAt}>{date(contact.createdAt)}</time>
        </header>
        {contact.scope === 'group' ? (
          <p className="request-note">
            The agent was added to this group. Approving covers everyone in it.
          </p>
        ) : contact.message ? (
          <blockquote className="request-quote">{contact.message}</blockquote>
        ) : (
          <p className="request-note">They have not written anything yet.</p>
        )}
        <footer>
          <p>
            {channel.enabled === false || contact.aiEnabled === false
              ? 'Approving does not turn the channel back on, nor answer what arrived while it was off.'
              : contact.scope === 'group'
                ? 'Until you approve, the agent reads nothing there.'
                : channel.type === 'whatsapp-business'
                  ? 'Approving hands this message to the agent. An expired reply window blocks delivery.'
                  : 'Approving hands this message to the agent, and it answers.'}
          </p>
          <Button
            variant="quiet"
            disabled={busy}
            aria-label={`Decline ${name}`}
            onClick={() => void refuse(contact, name)}
          >
            <UserX size={16} />
            Decline
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void approve(contact, name)}>
            <UserCheck size={16} />
            Approve
          </Button>
        </footer>
      </article>
    );
  };

  const row = (contact: Contact, detail: string) => {
    if (contact.status === 'pending') {
      return request(contact, detail);
    }

    const name = contact.displayName ?? contact.actorId;

    return (
      <div className="conversation-row" key={contact.id} data-status={contact.status}>
        <Face name={name} picture={contact.avatar} />
        <div className="grow">
          <strong>{name}</strong>
          {detail !== name && <small>{detail}</small>}
        </div>
        {contact.status === 'approved' ? (
          <>
            <Badge tone="good">Approved</Badge>
            <Button
              variant="quiet"
              disabled={busy}
              aria-label={`Revoke ${name}`}
              onClick={() => void refuse(contact, name)}
            >
              <ShieldOff size={16} />
              Revoke
            </Button>
          </>
        ) : (
          <>
            <Badge>Revoked</Badge>
            <Button
              variant="quiet"
              disabled={busy}
              aria-label={`Approve ${name} again`}
              onClick={() => void approve(contact, name)}
            >
              <UserCheck size={16} />
              Approve again
            </Button>
          </>
        )}
      </div>
    );
  };

  // Nobody has written yet: there is nothing to decide, so nothing is shown.
  if (!mine.length) return null;

  return (
    <div className="channel-conversations">
      {channel.type !== 'whatsapp-business' && groups.length > 0 && (
        <section>
          <h3>Groups</h3>
          {groups.map((contact) => {
            const room = rooms.find(
              (group) => group.type === contact.type && group.chatId === contact.chatId,
            );
            const others = (room?.profiles ?? []).filter(
              (item) => item.status === 'approved' && item.profileId !== profile.id,
            );

            return row(
              contact,
              others.length
                ? `With ${others.map((item) => item.name).join(', ')} · ${agents(others.length + 1)}`
                : 'The only agent here',
            );
          })}
        </section>
      )}
      {people.length > 0 && (
        <section>
          <h3>{channel.type === 'api' ? 'Senders' : 'Contacts'}</h3>
          {people.map((contact) => row(contact, contact.actorId))}
        </section>
      )}
    </div>
  );
}
