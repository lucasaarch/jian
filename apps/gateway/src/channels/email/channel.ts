import { randomUUID } from 'node:crypto';
import type { Channel, DeliveryContext, DeliveryOutcome, OutgoingMessage } from '../channel.js';
import { type EmailCredential, type EmailProvider, emailCredentialSchema } from './provider.js';
import { Resend } from './resend.js';
import { bareAddress, envelope } from './text.js';

/** The providers an email channel can use, by the name the owner chose at connect. */
export const EMAIL_PROVIDERS: Record<EmailCredential['provider'], EmailProvider> = {
  resend: new Resend(),
};

export function emailCredential(value: string | undefined): EmailCredential {
  if (!value) throw new Error('Email credentials are unavailable');
  return emailCredentialSchema.parse(JSON.parse(value));
}

/** `"Mia" <mia@example.com>`: the name loses what would let it break out of its quotes. */
export function sender(name: string, address: string) {
  const clean = name.replace(/["\\<>\r\n\t]/g, '').trim();
  return clean ? `"${clean}" <${address}>` : address;
}

/**
 * Email as a channel. Mail arrives only through the provider's signed webhook, which the
 * service reads with `EmailInbox`, so `receive` takes nothing. A turn leaves as one email:
 * an inbox is not a chat, and each paragraph said on the way would be another message.
 */
export class EmailChannel implements Channel {
  readonly type = 'email' as const;
  readonly rendersMarkdown = false;
  readonly wholeMessages = true;

  constructor(private readonly providers = EMAIL_PROVIDERS) {}

  receive() {
    return null;
  }

  async send(message: OutgoingMessage, context: DeliveryContext): Promise<DeliveryOutcome> {
    if (message.reaction || bareAddress(message.chatId) !== message.chatId) {
      return { status: 'failed', remoteMessageIds: [], error: 'Email goes to one address.' };
    }

    const credential = emailCredential(context.credential);
    const provider = this.providers[credential.provider];
    const mail = envelope(message.text, message.emailThread, message.media?.name);

    return provider.send(
      credential.apiKey,
      {
        ...mail,
        from: sender(credential.fromName, credential.address),
        to: message.chatId,
        ...(message.media ? { media: message.media } : {}),
      },
      context.deliveryId ?? randomUUID(),
      { fetch: context.fetch, signal: context.signal },
    );
  }
}
