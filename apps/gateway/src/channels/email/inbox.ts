import type { ingressResultSchema } from '@jian/contracts';
import type { z } from 'zod';
import { GatewayError } from '../../core/errors.js';
import type { Vault } from '../../security/vault.js';
import type { Queryable, Store } from '../../storage/database.js';
import type { IncomingMessage } from '../channel.js';
import { channelLog } from '../logging.js';
import { findChannel, findContactByChat, findDeliveryByRemoteId } from '../repository.js';
import { type ChannelRecord, channelSecret } from '../service.js';
import { EMAIL_PROVIDERS, emailCredential } from './channel.js';
import { logEmail } from './log.js';
import type { MailAuthentication, ReceivedEmail } from './provider.js';
import { expectedDomain, freeMail } from './signups.js';
import {
  bareAddress,
  displayNameOf,
  type EmailThread,
  mailBody,
  messageIds,
  oneLine,
  referencesOf,
} from './text.js';
import { ID_CHARS, saveEmailThread } from './threads.js';

type IngressResult = z.infer<typeof ingressResultSchema>;
type Headers = Readonly<Record<string, string | string[] | undefined>>;

/** What the agent reads of one email, below the line that names its subject. */
const TEXT_CHARS = 7800;
const SUBJECT_CHARS = 300;
/** How many of the ids a reply names are looked up among the emails the agent sent. */
const ANSWERED_LOOKUPS = 10;

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

/**
 * Mail a machine wrote on its own — an out-of-office, a bounce, a list, a ticket system's
 * acknowledgement. It is never a turn and never answered, or two machines answer each other.
 */
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

/**
 * One received email as a message for the agent, or undefined when it is not one to read.
 * Automatic mail is marked, not dropped: the inbox keeps it only when it answers an email the
 * agent sent, and the service never answers it.
 */
export function incoming(email: ReceivedEmail, own: string) {
  const from = bareAddress(email.headers.from ?? email.from);
  if (!from || from === own || from.length > 100) return undefined;
  if (!authenticated(email.authentication)) return undefined;

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
    ...(automatic(email.headers) ? { automatic: true } : {}),
  };

  const thread: EmailThread | undefined = messageId
    ? {
        subject,
        messageId,
        references: referencesOf(email.headers.references, messageId),
      }
    : undefined;

  return { message, thread, subject, body };
}

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);

/**
 * The address the agent sent the email this one answers to, from the ids it names: its
 * `In-Reply-To` first, then its `References` from the newest. Only the `Message-ID`s kept on the
 * agent's own deliveries match, so naming a thread takes having been sent a message in it.
 */
async function answeredAddress(db: Queryable, channelId: string, email: ReceivedEmail) {
  const named = [
    ...messageIds(email.headers['in-reply-to']),
    ...messageIds(email.headers.references).reverse(),
  ].filter((id) => id.length <= ID_CHARS);
  for (const id of [...new Set(named)].slice(0, ANSWERED_LOOKUPS)) {
    const delivery = await findDeliveryByRemoteId(db, channelId, id);
    if (delivery) return delivery.chatId;
  }
  return undefined;
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

    const { message, thread, subject, body } = read;
    const sender = message.chatId;
    const known = await findContactByChat(this.store.db, channelId, sender);
    const answered = await answeredAddress(this.store.db, channelId, email);
    // A support desk answers from another address of its domain than the one written to. In
    // the agent's own thread, signed by that domain, and from no contact of its own, it is the
    // reply of the address the agent wrote to. Nothing else widens who a message is from, and
    // never at a mailbox provider: two strangers there are not colleagues.
    if (
      answered &&
      answered !== message.chatId &&
      domainOf(answered) === domainOf(message.chatId) &&
      !freeMail(answered) &&
      !known
    ) {
      message.text = `From: ${message.chatId}\n${message.text}`.slice(0, TEXT_CHARS);
      message.actorId = answered;
      message.chatId = answered;
    }
    // A machine's mail matters only from someone the agent writes to, or from a service whose
    // mail it expects (`expect_email`): no-reply senders write confirmations. From anyone else
    // it is noise, dropped unread. Kept, it is still never answered and starts no turn.
    if (
      message.automatic &&
      answered !== message.chatId &&
      !(await findContactByChat(this.store.db, channelId, message.chatId)) &&
      !(await expectedDomain(this.store.db, channelId, message.chatId, Date.now()))
    )
      return { accepted: false };

    if (email.attachments) {
      const files = await provider.attachments(credential.apiKey, email.id, net);
      if (files.media?.length) message.media = files.media;
      if (files.note) message.text = `${message.text}\n${files.note}`;
    }

    await this.store.transaction(channel.profileId, async (tx) => {
      if (thread) await saveEmailThread(tx, channelId, message.chatId, thread);
      // What the owner blocked is not kept for the agent to read back either.
      if (known?.status !== 'blocked')
        await logEmail(tx, {
          profileId: channel.profileId,
          channelId,
          direction: 'received',
          address: sender,
          subject,
          text: body || '[An empty email]',
          key: email.id,
        });
    });

    return accept(channel, message);
  }
}
