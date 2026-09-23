'use client';

import { MessageCircle, ShieldOff, UserCheck, Users } from 'lucide-react';
import type { Channel, Contact } from '../../lib/api';
import type { SectionProps } from '../props';
import { Badge, Button } from '../ui';

const agents = (count: number) => (count === 1 ? '1 agent' : `${count} agents`);

/**
 * Who this channel reaches for the profile: its groups and the people approved on it. Revoking
 * one stops the agent answering there and keeps the conversation; approving again restores it.
 * Requests still waiting on a decision live at the top of the screen, not here.
 */
export function Conversations({
  channel,
  profile,
  data,
  api,
  mutate,
  busy,
}: SectionProps & { channel: Channel }) {
  const decided = data.contacts.filter(
    (contact) => contact.channelId === channel.id && contact.status !== 'pending',
  );
  const groups = decided.filter((contact) => contact.scope === 'group');
  const people = decided.filter((contact) => contact.scope !== 'group');

  const toggle = (contact: Contact, name: string) =>
    contact.status === 'approved'
      ? mutate(
          () => api.blockContact(profile.id, contact.id),
          `${name} revoked. The agent no longer answers there.`,
        )
      : mutate(() => api.approveContact(profile.id, contact.id), `${name} approved again.`);

  const row = (contact: Contact, detail: string, icon: typeof Users) => {
    const Icon = icon;
    const name = contact.displayName ?? contact.actorId;
    const approved = contact.status === 'approved';

    return (
      <div className="conversation-row" key={contact.id} data-status={contact.status}>
        <Icon size={18} aria-hidden="true" />
        <div className="grow">
          <strong>{name}</strong>
          <small>{detail}</small>
        </div>
        <Badge tone={approved ? 'good' : 'neutral'}>{approved ? 'Approved' : 'Revoked'}</Badge>
        <Button
          variant="quiet"
          disabled={busy}
          aria-label={`${approved ? 'Revoke' : 'Approve again'} ${name}`}
          onClick={() => void toggle(contact, name)}
        >
          {approved ? <ShieldOff size={16} /> : <UserCheck size={16} />}
          {approved ? 'Revoke' : 'Approve again'}
        </Button>
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
          <p className="note">Nobody yet. A first message from someone becomes a request above.</p>
        )}
      </section>
      <p className="note">
        In a group the agent reads everything and answers only when someone mentions it or replies
        to it.
      </p>
    </div>
  );
}
