import {
  cloudflareEmailSchema,
  type emailInputSchema,
  type InlineMedia,
  resendEmailSchema,
} from '@jian/contracts';
import { z } from 'zod';
import type { DeliveryOutcome } from '../channel.js';
import type { Envelope } from './text.js';

/** What every provider keeps: the name mail goes out under and how its webhook is told apart. */
const kept = {
  fromName: z.string().max(100),
  /** Resend's webhook id, or the Cloudflare Worker script that forwards this address's mail. */
  webhookId: z.string().min(1).max(200),
  signingSecret: z.string().min(1).max(500),
};

/**
 * What the vault keeps for an email channel under `channel:<id>`: the owner's provider key, the
 * address, the name mail goes out under (the profile's, as it was at connect), and the webhook
 * the provider was told to call with the secret it signs every event with. On Cloudflare, also
 * the zone and routing rule made at connect, so disconnecting takes them back.
 */
export const emailCredentialSchema = z.discriminatedUnion('provider', [
  resendEmailSchema.extend(kept),
  cloudflareEmailSchema.extend({
    ...kept,
    zoneId: z.string().min(1).max(64),
    ruleId: z.string().min(1).max(64),
  }),
]);

export type EmailCredential = z.infer<typeof emailCredentialSchema>;
export type EmailInput = z.infer<typeof emailInputSchema>;

/** What registering a channel's webhook leaves to keep with the credential. */
export type Subscription = { webhookId: string; signingSecret: string } & Partial<
  Record<'zoneId' | 'ruleId', string>
>;

/** Who signed a received message for its sender's domain, as the provider checked it. */
export type MailAuthentication = { spf?: string; dkim?: string; dmarc?: string } | null;

/** The files of a received email; a file that cannot be had is a note, never an error. */
export type ReceivedFiles = { media?: InlineMedia[]; note?: string };

/** As many files as one incoming message may carry into a run. */
export const MAX_FILES = 4;
export const FILE_NOTE =
  '[An attachment could not be downloaded or exceeds 16 MB. Ask the sender to send it again in a smaller file.]';
export const MORE_FILES_NOTE = `[Only the first ${MAX_FILES} attachments were kept.]`;

/** A received email as the provider reads it back, or as its webhook carried it whole. */
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
  /** The files already in hand, when the webhook carried the whole message. */
  files?: ReceivedFiles;
};

/**
 * An email the agent sends, with the thread it answers already resolved by the gateway. `text`
 * is the plain part, readable as it is; `html` the same words drawn from their Markdown. `cc`
 * are bare addresses the owner already let it write to.
 */
export type OutgoingEmail = Envelope & {
  from: string;
  to: string;
  html?: string;
  cc?: string[];
  attachments?: InlineMedia[];
};

/** Network access for one call, as the gateway hands it to every adapter. */
export type Net = { fetch: typeof globalThis.fetch; signal: AbortSignal };

export type WebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;

/**
 * The received email a webhook request announces. A provider that keeps mail names it by id and
 * the inbox reads it back; one that keeps nothing carries it whole in `email`.
 */
export type MailEvent = { emailId: string; recipients: string[]; email?: ReceivedEmail };

/**
 * One email provider: how the gateway checks an account, is told about mail, reads it and
 * sends it. Failures that the owner can fix are `GatewayError`s with a message for them.
 */
export interface EmailProvider {
  /** That the key works and the address's domain may send and receive here. */
  verify(input: EmailInput, net: Net): Promise<void>;
  /** Registers the webhook that receives this channel's mail. */
  subscribe(input: EmailInput, endpoint: string, net: Net): Promise<Subscription>;
  /** Best effort: a webhook left behind only calls a channel that no longer answers. */
  unsubscribe(credential: EmailCredential, net: Net): Promise<void>;
  /** Whether a webhook request was signed with the channel's secret, over its exact bytes. */
  authentic(raw: Buffer, headers: WebhookHeaders, secret: string): boolean;
  /**
   * The received email an authentic request announces, or undefined for any other event. A
   * request that is not one this provider sends is a 400 `GatewayError`.
   */
  event(raw: Buffer, headers: WebhookHeaders): Promise<MailEvent | undefined>;
  /** Only for a provider whose events name an email instead of carrying it. */
  read?(credential: EmailCredential, emailId: string, net: Net): Promise<ReceivedEmail>;
  attachments?(credential: EmailCredential, emailId: string, net: Net): Promise<ReceivedFiles>;
  /**
   * `idempotencyKey`, the delivery id, makes a retried send land once where the provider takes
   * one. Where it does not (Cloudflare), a send whose answer was lost is `unknown`, never retried.
   */
  send(
    credential: EmailCredential,
    email: OutgoingEmail,
    idempotencyKey: string,
    net: Net,
  ): Promise<DeliveryOutcome>;
}
