'use client';

import { MessageCircle, ShieldOff, UserCheck, Users, UserX } from 'lucide-react';
import type { Channel, Contact } from '../../lib/api';
import type { SectionProps } from '../props';
import { Badge, Button } from '../ui';

const agents = (count: number) => (count === 1 ? '1 agent' : `${count} agents`);

/**
 * Who this channel reaches for the profile: its groups and its people. A request waiting on the
 * owner comes first, with what it said. Revoking stops the agent answering there and keeps the
 * conversation; approving again restores it.
 */
export function Conversations({
  channel,
  profile,
  data,
  api,
  mutate,
  busy,
}: SectionProps & { channel: Channel }) {
  // Waiting first, then approved, then revoked: what needs a decision is never below the fold.
  const order = { pending: 0, approved: 1, blocked: 2 } as const;
  const mine = data.contacts
    .filter((contact) => contact.channelId === channel.id)
    .sort((a, b) => order[a.status] - order[b.status]);
  const groups = mine.filter((contact) => contact.scope === 'group');
  const people = mine.filter((contact) => contact.scope !== 'group');

  const approve = (contact: Contact, name: string) =>
    mutate(
      () => api.approveContact(profile.id, contact.id),
      contact.status === 'pending'
        ? `${name} approved. What they wrote went to the agent.`
        : `${name} approved again.`,
    );
  const refuse = (contact: Contact, name: string) =>
    mutate(
      () => api.blockContact(profile.id, contact.id),
      contact.status === 'pending'
        ? `${name} declined.`
        : `${name} revoked. The agent no longer answers there.`,
    );

  const row = (contact: Contact, detail: string, icon: typeof Users) => {
    const Icon = icon;
    const name = contact.displayName ?? contact.actorId;
    const said =
      contact.scope === 'group'
        ? 'Approving covers the whole group.'
        : (contact.message ?? 'Nothing is waiting from them.');

    return (
      <div className="conversation-row" key={contact.id} data-status={contact.status}>
        <Icon size={18} aria-hidden="true" />
        <div className="grow">
          <strong>{name}</strong>
          {detail !== name && <small>{detail}</small>}
          {contact.status === 'pending' && <p className="conversation-message">{said}</p>}
        </div>
        {contact.status === 'pending' ? (
          <>
            <Badge tone="accent">Pending</Badge>
            <Button variant="secondary" disabled={busy} onClick={() => void approve(contact, name)}>
              <UserCheck size={16} />
              Approve
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              aria-label={`Decline ${name}`}
              onClick={() => void refuse(contact, name)}
            >
              <UserX size={16} />
            </Button>
          </>
        ) : contact.status === 'approved' ? (
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

  return (
    <div className="channel-conversations">
      <section>
        <h3>Groups</h3>
        {groups.length ? (
          groups.map((contact) => {
            const room = data.groups.find(
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
              Users,
            );
          })
        ) : (
          <p className="note">No groups yet. Add the agent to one and approve the request.</p>
        )}
      </section>
      <section>
        <h3>Contacts</h3>
        {people.length ? (
          people.map((contact) => row(contact, contact.actorId, MessageCircle))
        ) : (
          <p className="note">Nobody yet. Someone's first message shows up here as a request.</p>
        )}
      </section>
      <p className="note">
        In a group the agent reads everything and answers only when someone mentions it or replies
        to it.
      </p>
    </div>
  );
}
