import { GROUP_AGENT_TURN_LIMIT, type GroupTurn } from '@jian/contracts';
import type { ProfileReader } from '../profiles/port.js';
import type { Queryable } from '../storage/database.js';
import type { IncomingMessage } from './channel.js';
import type { ContactRecord } from './contacts.js';
import { listGroupContacts, listLiveChannelsOfType, updateContact } from './repository.js';
import type { ChannelRecord } from './service.js';

/**
 * How many recent protocol message ids a room remembers. A redelivered message must not spend
 * a turn twice, and the protocols repeat the most recent messages, not arbitrary old ones.
 */
const OBSERVED_KEYS = 32;

export type GroupDecision =
  | { speak: true; turn: GroupTurn }
  | { speak: false; reason: 'unaddressed' | 'budget' };

type Participant = { profileId: string; name: string };

const quote = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case and accents are not how a person addresses an agent, so neither decides the match. */
const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();

/**
 * A room where people and agents write. Two rules keep it usable: an agent reads everything but
 * answers only when called, and the agents of this installation share one budget of
 * consecutive turns, so a conversation between them ends without a person having to stop it.
 */
export class Groups {
  constructor(private readonly profiles: ProfileReader) {}

  /**
   * A person calls an agent the way the protocol offers: a mention of its connection, or a
   * reply to one of its messages. Writing the name is not a call — people talk *about* an agent
   * too. Agents cannot produce either gesture, so from another agent the name in the text counts,
   * and the first word of a composed name with it, because that is how a name is written.
   */
  static addressed(
    message: IncomingMessage,
    self: { name: string; address?: string; handle?: string },
    fromAgent: boolean,
  ): boolean {
    const called = [self.address, self.handle].filter((item): item is string => Boolean(item));

    if (called.some((item) => message.mentions.includes(item) || message.replyTo === item)) {
      return true;
    }

    if (!fromAgent) {
      return false;
    }

    const name = self.name;
    const text = fold(message.text);
    const full = fold(name).trim();
    const first = full.split(/\s+/)[0] ?? '';
    const words = new Set([full, ...(first.length >= 3 ? [first] : [])]);

    return [...words].some((word) =>
      new RegExp(`(?<![\\p{L}\\p{N}])${quote(word)}(?![\\p{L}\\p{N}])`, 'u').test(text),
    );
  }

  /** The other profiles of this installation, recognised by the address their channel speaks as. */
  private async fromAgent(tx: Queryable, channel: ChannelRecord, actorId: string) {
    const channels = await listLiveChannelsOfType(tx, channel.type);

    return channels.some((item) => item.id !== channel.id && item.address === actorId);
  }

  /** Who of this installation answers in this room: an approved group contact is membership. */
  async participants(tx: Queryable, contact: ContactRecord): Promise<Participant[]> {
    const contacts = await listGroupContacts(tx, {
      type: contact.type,
      chatId: contact.chatId,
      status: 'approved',
    });

    const participants: Participant[] = [];

    for (const item of contacts) {
      const profile = await this.profiles.profile(item.profileId, tx).catch(() => null);

      if (profile) {
        participants.push({ profileId: profile.id, name: profile.name });
      }
    }

    return participants;
  }

  /**
   * Reads one group message and decides whether this profile answers it. The counter lives on
   * the room's contact and is written here, inside the caller's transaction: observing an
   * agent spends a turn, a person writing returns the budget, and a message already seen
   * changes nothing — a protocol redelivery is the same turn, not a new one.
   */
  async observe(
    tx: Queryable,
    channel: ChannelRecord,
    contact: ContactRecord,
    message: IncomingMessage,
    profileName: string,
  ): Promise<GroupDecision> {
    const fromAgent = await this.fromAgent(tx, channel, message.actorId);
    const seen = contact.seen ?? [];
    const duplicate = seen.includes(message.requestKey);
    const observed = duplicate
      ? (contact.agentTurns ?? 0)
      : fromAgent
        ? (contact.agentTurns ?? 0) + 1
        : 0;

    const save = async (turns: number) => {
      if (duplicate) {
        return;
      }

      await updateContact(tx, {
        ...contact,
        agentTurns: turns,
        seen: [...seen, message.requestKey].slice(-OBSERVED_KEYS),
      });
    };

    const participants = await this.participants(tx, contact);
    const others = participants.filter((item) => item.profileId !== channel.profileId);
    // The API server has no protocol identity; the adapter calling it mentions the channel id.
    const address = channel.address ?? (channel.type === 'api' ? channel.id : undefined);
    const self = {
      name: profileName,
      ...(address ? { address } : {}),
      ...(channel.handle ? { handle: channel.handle } : {}),
    };

    // Even alone in the room: a group is a conversation among people, not a request to the agent.
    if (!Groups.addressed(message, self, fromAgent)) {
      await save(observed);

      return { speak: false, reason: 'unaddressed' };
    }

    // A message already seen is judged by the same spent budget: a redelivery must never be
    // what reopens a conversation the limit closed.
    if (fromAgent && observed >= GROUP_AGENT_TURN_LIMIT) {
      await save(observed);

      return { speak: false, reason: 'budget' };
    }

    const turns = Math.min(
      duplicate ? Math.max(observed, 1) : observed + 1,
      GROUP_AGENT_TURN_LIMIT,
    );

    await save(turns);

    return {
      speak: true,
      turn: {
        chatId: contact.chatId,
        ...(contact.displayName ? { name: contact.displayName } : {}),
        fromName: message.displayName ?? message.actorId,
        fromAgent,
        turns,
        agents: others.map((item) => item.name),
      },
    };
  }
}
