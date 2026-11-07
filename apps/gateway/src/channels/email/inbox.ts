import type { ingressResultSchema } from '@jian/contracts';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { GatewayError } from '../../core/errors.js';
import type { Vault } from '../../security/vault.js';
import type { Queryable, Store } from '../../storage/database.js';
import { emailThreads } from '../../storage/schema.js';
import type { IncomingMessage } from '../channel.js';
import { channelLog } from '../logging.js';
import { findChannel } from '../repository.js';
import { type ChannelRecord, channelSecret } from '../service.js';
import { EMAIL_PROVIDERS, emailCredential } from './channel.js';
import type { MailAuthentication, ReceivedEmail } from './provider.js';
import {
  bareAddress,
  displayNameOf,
  type EmailThread,
  mailBody,
  messageIds,
  oneLine,
  referencesOf,
} from './text.js';

type IngressResult = z.infer<typeof ingressResultSchema>;
type Headers = Readonly<Record<string, string | string[] | undefined>>;

/** What the agent reads of one email, below the line that names its subject. */
const TEXT_CHARS = 7800;
const SUBJECT_CHARS = 300;
/** As far as a message id may go into a field the gateway keeps for it. */
const ID_CHARS = 200;

/**
 * Whether the sender's domain vouched for this message. `From` is only text anyone can write,
 * and an approved contact starts runs with the owner's tools, so mail is attributed to its
 * sender only when DMARC passed or the message carries a DKIM signature of the `From` domain.
 * DKIM is accepted alone because a domain without an enforcing DMARC policy — gmail.com
 * publishes `p=none` — reads as `gray` even for its own signed mail.
 */
export function authenticated(authentication: MailAuthentication): boolean {
  return authentication?.dmarc === 'pass' || authentication?.dkim === 'pass';
}

/** Mail a machine wrote on its own — an out-of-office, a bounce, a list — is not a turn. */
export function automatic(headers: Record<string, string>): boolean {
  const submitted = headers['auto-submitted']?.split(';')[0]?.trim().toLowerCase();
  const precedence = headers.precedence?.trim().toLowerCase();
  return (
    (submitted !== undefined && submitted !== 'no') ||
    precedence === 'bulk' ||
    precedence === 'junk' ||
    precedence === 'list'
  );
}

/** One received email as a message for the agent, or undefined when it is not one to answer. */
export function incoming(email: ReceivedEmail, own: string) {
  const from = bareAddress(email.headers.from ?? email.from);
  if (!from || from === own || from.length > 100) return undefined;
  if (!authenticated(email.authentication) || automatic(email.headers)) return undefined;

  const subject = oneLine(email.subject).slice(0, SUBJECT_CHARS);
  const body = mailBody(email.text, email.html);
  const text =
    (subject ? `Subject: ${subject}\n\n${body}` : body).trim().slice(0, TEXT_CHARS) ||
    '[An empty email]';
  const messageId = messageIds(email.messageId).find((id) => id.length <= ID_CHARS);
  const answered = messageIds(email.headers['in-reply-to']).find((id) => id.length <= ID_CHARS);
  const name = displayNameOf(email.headers.from);

  const message: IncomingMessage = {
    actorId: from,
    chatId: from,
    text,
    requestKey: `email:${email.id}`,
    scope: 'direct',
    mentions: [],
    ...(name ? { displayName: name } : {}),
    ...(messageId ? { channelMessage: { id: messageId } } : {}),
    ...(answered ? { target: answered } : {}),
  };

  const thread: EmailThread | undefined = messageId
    ? {
        subject,
        messageId,
        references: referencesOf(email.headers.references, messageId),
      }
    : undefined;

  return { message, thread };
}

/** The thread a reply to this person continues, when they have written in one. */
export async function findEmailThread(
  db: Queryable,
  channelId: string,
  chatId: string,
): Promise<EmailThread | undefined> {
  const [row] = await db
    .select({
      subject: emailThreads.subject,
      messageId: emailThreads.messageId,
      references: emailThreads.references,
    })
    .from(emailThreads)
    .where(and(eq(emailThreads.channelId, channelId), eq(emailThreads.chatId, chatId)))
    .limit(1);
  return row;
}

/**
 * Mail for an email channel, as the provider's webhook announces it. Each event is checked
 * against the channel's own signing secret, read in full from the provider, and handed to the
 * gateway's ordinary intake. Taken in while the webhook waits, like Telegram: a failure to read
 * the email answers 502, so the provider delivers the event again, and the request key keeps
 * a second delivery from starting a second run.
 */
export class EmailInbox {
  constructor(
    private readonly store: Store,
    private readonly vault: Vault,
    private readonly fetcher: typeof fetch,
    private readonly signal: AbortSignal,
    private readonly providers = EMAIL_PROVIDERS,
  ) {}

  async receive(
    channelId: string,
    raw: Buffer,
    headers: Headers,
    accept: (channel: ChannelRecord, message: IncomingMessage) => Promise<IngressResult>,
  ): Promise<IngressResult> {
    const channel = await findChannel(this.store.db, channelId);
    if (!channel || channel.revokedAt || channel.type !== 'email')
      throw new GatewayError(401, 'Unauthorized');
    const stored = await this.vault.read(channel.profileId, channelSecret(channelId));
    if (!stored) throw new GatewayError(401, 'Unauthorized');
    const credential = emailCredential(stored);
    const provider = this.providers[credential.provider];
    if (!provider.authentic(raw, headers, credential.signingSecret))
      throw new GatewayError(401, 'Unauthorized');

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new GatewayError(400, 'Invalid email event');
    }
    const event = provider.event(payload);
    if (!event || !channel.enabled) return { accepted: false };
    // The webhook hears every address of the domain; only this channel's mail is its own.
    if (!event.recipients.includes(credential.address)) return { accepted: false };

    const net = { fetch: this.fetcher, signal: this.signal };
    let email: ReceivedEmail;
    try {
      email = await provider.read(credential.apiKey, event.emailId, net);
    } catch {
      throw new GatewayError(502, 'The email could not be read from the provider');
    }

    const read = incoming(email, credential.address);
    if (!read) {
      if (!authenticated(email.authentication)) channelLog('email.unauthenticated', { channelId });
      return { accepted: false };
    }

    const { message, thread } = read;
    if (email.attachments) {
      const files = await provider.attachments(credential.apiKey, email.id, net);
      if (files.media?.length) message.media = files.media;
      if (files.note) message.text = `${message.text}\n${files.note}`;
    }

    if (thread) {
      await this.store.transaction(channel.profileId, async (tx) => {
        const values = { channelId, chatId: message.chatId, ...thread, updatedAt: new Date() };
        await tx
          .insert(emailThreads)
          .values(values)
          .onConflictDoUpdate({
            target: [emailThreads.channelId, emailThreads.chatId],
            set: {
              subject: values.subject,
              messageId: values.messageId,
              references: values.references,
              updatedAt: values.updatedAt,
            },
          });
      });
    }

    return accept(channel, message);
  }
}
