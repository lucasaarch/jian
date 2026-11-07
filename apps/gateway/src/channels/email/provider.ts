import { emailInputSchema, type InlineMedia } from '@jian/contracts';
import { z } from 'zod';
import type { DeliveryOutcome } from '../channel.js';
import type { Envelope } from './text.js';

/**
 * What the vault keeps for an email channel under `channel:<id>`: the owner's provider key, the
 * address, the name mail goes out under (the profile's, as it was at connect), and the webhook
 * the provider was told to call with the secret it signs every event with.
 */
export const emailCredentialSchema = emailInputSchema.extend({
  fromName: z.string().max(100),
  webhookId: z.string().min(1).max(200),
  signingSecret: z.string().min(1).max(500),
});

export type EmailCredential = z.infer<typeof emailCredentialSchema>;

/** Who signed a received message for its sender's domain, as the provider checked it. */
export type MailAuthentication = { spf?: string; dkim?: string; dmarc?: string } | null;

/** A received email as the provider reads it back: the event that announced it has no body. */
export type ReceivedEmail = {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  receivedFor: string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  /** Lowercased names; a header given more than once keeps its first value. */
  headers: Record<string, string>;
  messageId?: string;
  authentication: MailAuthentication;
  attachments: number;
};

/** An email the agent sends, with the thread it answers already resolved by the gateway. */
export type OutgoingEmail = Envelope & {
  from: string;
  to: string;
  media?: InlineMedia;
};

/** Network access for one call, as the gateway hands it to every adapter. */
export type Net = { fetch: typeof globalThis.fetch; signal: AbortSignal };

/**
 * One email provider: how the gateway checks an account, is told about mail, reads it and
 * sends it. Failures that the owner can fix are `GatewayError`s with a message for them.
 */
export interface EmailProvider {
  /** That the key works and the address's domain may send and receive here. */
  verify(apiKey: string, address: string, net: Net): Promise<void>;
  /** Registers the webhook that receives this channel's mail. */
  subscribe(
    apiKey: string,
    endpoint: string,
    net: Net,
  ): Promise<{ webhookId: string; signingSecret: string }>;
  /** Best effort: a webhook left behind only calls a channel that no longer answers. */
  unsubscribe(apiKey: string, webhookId: string, net: Net): Promise<void>;
  /** Whether a webhook request was signed with the channel's secret, over its exact bytes. */
  authentic(
    raw: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>,
    secret: string,
  ): boolean;
  /** The received email a webhook event announces, or undefined for any other event. */
  event(payload: unknown): { emailId: string; recipients: string[] } | undefined;
  read(apiKey: string, emailId: string, net: Net): Promise<ReceivedEmail>;
  /** The files of a received email; a file that cannot be fetched is a note, never an error. */
  attachments(
    apiKey: string,
    emailId: string,
    net: Net,
  ): Promise<{ media?: InlineMedia[]; note?: string }>;
  /** `idempotencyKey` makes a retried send land once; the delivery id is used. */
  send(
    apiKey: string,
    email: OutgoingEmail,
    idempotencyKey: string,
    net: Net,
  ): Promise<DeliveryOutcome>;
}
