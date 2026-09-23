import type { channelTypeSchema, InlineMedia, ingressSchema } from '@jian/contracts';
import type { z } from 'zod';

export type ChannelType = z.infer<typeof channelTypeSchema>;

export type IncomingMessage = z.infer<typeof ingressSchema>;

export interface ChannelRequest {
  type: ChannelType;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  payload: unknown;
}

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

  receive(payload: unknown): IncomingMessage | null;

  /**
   * What this connection speaks as on its protocol, asked once when the channel is connected.
   * A protocol that cannot answer leaves the connection unidentified, and the messages of the
   * installation's other agents are then read as anyone else's.
   */
  identify?(
    credential: string,
    fetch: typeof globalThis.fetch,
    signal: AbortSignal,
  ): Promise<string | undefined>;

  /**
   * Points the protocol at this channel's webhook under `origin`, signed with `secret`. False
   * means the protocol refused or never answered; the channel stays connected either way, and
   * the owner can still register the address by hand.
   */
  register?(
    credential: string,
    webhook: { channelId: string; origin: string; secret: string },
    fetch: typeof globalThis.fetch,
    signal: AbortSignal,
  ): Promise<boolean>;

  canSend?(channelId: string): Promise<boolean>;
  // An absent sender describes an ingress-only channel; it is not a fake successful delivery.
  send?(message: OutgoingMessage, context: DeliveryContext): Promise<DeliveryOutcome>;

  /**
   * Shows the person that the agent is answering. Protocols expire this after a few seconds,
   * so it is called again on every dispatch tick and never has to be switched off.
   */
  typing?(chatId: string, context: DeliveryContext): Promise<void>;
}
