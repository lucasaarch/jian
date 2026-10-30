import type { Channel, Contact, GatewayApi, Group, Mutation } from '../../lib/api';

/** How a contact is called: the name their app gives, or the address they write from. */
export const contactName = (contact: Contact) => contact.displayName ?? contact.actorId;

// Waiting first, then approved, then revoked: what needs a decision is never below the fold.
const order = { pending: 0, approved: 1, blocked: 2 } as const;

/** Who this channel reaches, those waiting on the owner first. */
export const channelContacts = (contacts: Contact[], channel: Channel) =>
  contacts
    .filter((contact) => contact.channelId === channel.id)
    .sort((a, b) => order[a.status] - order[b.status]);

/** How many on this channel wait for the owner's decision. */
export const waitingOn = (contacts: Contact[], channel: Channel) =>
  contacts.filter((contact) => contact.channelId === channel.id && contact.status === 'pending')
    .length;

/** Whether the agent would stay quiet there even once approved. */
const silenced = (channel: Channel, contact: Contact) =>
  channel.enabled === false || contact.aiEnabled === false;

/** What approving a request does, said beside its two answers. */
export const requestNote = (channel: Channel, contact: Contact) =>
  silenced(channel, contact)
    ? 'Approving does not turn the channel back on, nor answer what arrived while it was off.'
    : contact.scope === 'group'
      ? 'Until you approve, the agent reads nothing there.'
      : channel.type === 'whatsapp-business'
        ? 'Approving hands this message to the agent. An expired reply window blocks delivery.'
        : 'Approving hands this message to the agent, and it answers.';

const agents = (count: number) => (count === 1 ? '1 agent' : `${count} agents`);

/**
 * The other agents of this installation sitting in a group contact's room, from the groups the
 * gateway knows: distinct from this channel's group contacts.
 */
export const roommates = (contact: Contact, rooms: Group[], profileId: string) => {
  const room = rooms.find(
    (group) => group.type === contact.type && group.chatId === contact.chatId,
  );

  return (room?.profiles ?? []).filter(
    (item) => item.status === 'approved' && item.profileId !== profileId,
  );
};

/** Who else answers in a room, in a line. */
export const roomLine = (others: { name: string }[]) =>
  others.length
    ? `With ${others.map((item) => item.name).join(', ')} · ${agents(others.length + 1)}`
    : 'The only agent here';

/**
 * The owner's answers about a contact. Revoking stops the agent answering there and keeps the
 * conversation; approving again restores it. Approving actions is trust beyond talking to the
 * agent: it runs what the agent asked to do. Each resolves false when the gateway refused.
 */
export function contactActions(
  { api, mutate }: { api: GatewayApi; mutate: Mutation },
  profileId: string,
  channel: Channel,
) {
  return {
    approve: (contact: Contact) => {
      const name = contactName(contact);

      return mutate(
        () => api.approveContact(profileId, contact.id),
        silenced(channel, contact)
          ? `${name} approved. The agent stays quiet there until the channel and the contact are on again.`
          : contact.status === 'pending'
            ? channel.type === 'whatsapp-business'
              ? `${name} approved. Replies still require an open customer-service window.`
              : `${name} approved. What they wrote went to the agent.`
            : `${name} approved again.`,
      );
    },
    refuse: (contact: Contact) => {
      const name = contactName(contact);

      return mutate(
        () => api.blockContact(profileId, contact.id),
        contact.status === 'pending'
          ? `${name} declined.`
          : `${name} revoked. The agent no longer answers there.`,
      );
    },
    trust: (contact: Contact, canApprove: boolean) => {
      const name = contactName(contact);

      return mutate(
        () => api.updateContact(profileId, contact.id, { canApprove }),
        canApprove
          ? `${name} can now approve what the agent asks to do.`
          : `${name} can no longer approve actions.`,
      );
    },
  };
}
