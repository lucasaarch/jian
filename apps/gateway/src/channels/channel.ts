import type { channelTypeSchema, InlineMedia, ingressSchema } from '@jian/contracts';
import type { z } from 'zod';

export type ChannelType = z.infer<typeof channelTypeSchema>;

export type IncomingMessage = z.infer<typeof ingressSchema>;

export interface ChannelRequest {
  type: ChannelType;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  payload: unknown;
}

/** The protocol itself said no to a credential: it answered, and the answer was a refusal. */
export class CredentialRefused extends Error {}

export interface OutgoingMessage {
  chatId: string;
  text: string;
  media?: InlineMedia;
}

export interface DeliveryContext {
  channelId: string;
  connectionGeneration?: number;
  credential?: string;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
}

export interface DeliveryOutcome {
  /**
   * `pending` is the one outcome that asks to be tried again: the protocol said the message
   * was not delivered and named a wait. Every other status is terminal, because a message
   * that may have landed must never be sent twice.
   */
  status: 'sent' | 'failed' | 'unknown' | 'pending';
  remoteMessageIds: Array<string | number>;
}

/** Protocol adapters never choose the profile, session or permissions of an incoming message. */
export interface Channel {
  readonly type: ChannelType;
  readonly webhookHeader?: string;

  /**
   * Whether this protocol draws Markdown. Absent means it does not, which is the safe default:
   * a chat bubble shows the marks instead of the formatting, so the gateway sends plain text
   * unless an adapter says otherwise.
   */
  readonly rendersMarkdown?: boolean;

  /**
   * True when the protocol never shows one agent's messages to another in a room. Telegram
   * does not deliver a bot's messages to other bots, privacy mode or not, so the gateway
   * carries them itself; WhatsApp numbers read each other like anyone else.
   */
  readonly hidesAgentsFromEachOther?: boolean;

  receive(payload: unknown): IncomingMessage | null;

  /**
   * The files a received payload points to, fetched with the channel's credential. A protocol
   * whose payload already carries its files has none of this. A file that cannot be fetched is
   * a note for the agent, never a lost message.
   */
  download?(
    payload: unknown,
    context: DeliveryContext,
  ): Promise<{ media?: InlineMedia[]; note?: string }>;

  /**
   * What this connection speaks as on its protocol, asked once when the channel is connected.
   * Throws `CredentialRefused` when the protocol rejects the credential; undefined means it
   * could not be asked, which is not the same thing.
   */
  identify?(
    credential: string,
    fetch: typeof globalThis.fetch,
    signal: AbortSignal,
  ): Promise<{ address: string; handle?: string } | undefined>;

  /**
   * Points the protocol at this channel's webhook under `origin`, signed with `secret`. When it
   * is not registered, `reason` is what the protocol said, or that it did not answer.
   */
  register?(
    credential: string,
    webhook: { channelId: string; origin: string; secret: string },
    fetch: typeof globalThis.fetch,
    signal: AbortSignal,
  ): Promise<{ registered: boolean; reason?: string }>;

  canSend?(channelId: string): Promise<boolean>;
  // An absent sender describes an ingress-only channel; it is not a fake successful delivery.
  send?(message: OutgoingMessage, context: DeliveryContext): Promise<DeliveryOutcome>;

  /**
   * Shows the person that the agent is answering. Protocols expire this after a few seconds,
   * so it is called again on every dispatch tick and never has to be switched off.
   */
  typing?(chatId: string, context: DeliveryContext): Promise<void>;

  /**
   * Puts the profile's picture on the account this channel speaks as, or takes it off when the
   * picture is null. False means it cannot be done from here right now — a WhatsApp device held
   * by another process, or not paired yet — and it is tried again later; a refusal throws.
   */
  setPicture?(picture: InlineMedia | null, context: DeliveryContext): Promise<boolean>;

  /**
   * The picture a person or a group shows on this protocol, small, or nothing when there is
   * none or it cannot be read from here. Never a reason to fail anything.
   */
  avatar?(
    target: { chatId: string; actorId: string; scope: 'direct' | 'group' },
    context: DeliveryContext,
  ): Promise<InlineMedia | undefined>;
}
