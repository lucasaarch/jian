import { randomUUID } from 'node:crypto';
import type { Channel, DeliveryContext, DeliveryOutcome, OutgoingMessage } from '../channel.js';
import { plainText } from '../plain.js';
import { Cloudflare } from './cloudflare.js';
import { emailHtml } from './html.js';
import { type EmailCredential, type EmailProvider, emailCredentialSchema } from './provider.js';
import { Resend } from './resend.js';
import { bareAddress, envelope } from './text.js';

/** The providers an email channel can use, by the name the owner chose at connect. */
export const EMAIL_PROVIDERS: Record<EmailCredential['provider'], EmailProvider> = {
  resend: new Resend(),
  cloudflare: new Cloudflare(),
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
 * an inbox is not a chat, and each paragraph said on the way would be another message. The
 * Markdown the agent writes arrives here whole, and leaves as both parts of the email: HTML
 * drawn from it, and plain text for a client that shows no HTML.
 */
export class EmailChannel implements Channel {
  readonly type = 'email' as const;
  readonly rendersMarkdown = true;
  readonly wholeMessages = true;

  constructor(private readonly providers = EMAIL_PROVIDERS) {}

  receive() {
    return null;
  }

  async send(message: OutgoingMessage, context: DeliveryContext): Promise<DeliveryOutcome> {
    if (message.reaction || bareAddress(message.chatId) !== message.chatId) {
      return { status: 'failed', remoteMessageIds: [], error: 'Email goes to one address.' };
    }
    // Checked again here, as the last step before the provider: only bare addresses.
    const cc = message.cc ?? [];
    if (cc.some((address) => bareAddress(address) !== address)) {
      return { status: 'failed', remoteMessageIds: [], error: 'A copied address is not valid.' };
    }

    const credential = emailCredential(context.credential);
    const provider = this.providers[credential.provider];
    const files = [...(message.media ? [message.media] : []), ...(message.attachments ?? [])];
    const mail = envelope(message.text, message.emailThread, files[0]?.name);

    return provider.send(
      credential,
      {
        ...mail,
        text: plainText(mail.text),
        ...(mail.text ? { html: emailHtml(mail.text) } : {}),
        from: sender(credential.fromName, credential.address),
        to: message.chatId,
        ...(cc.length ? { cc } : {}),
        ...(files.length ? { attachments: files } : {}),
      },
      context.deliveryId ?? randomUUID(),
      { fetch: context.fetch, signal: context.signal },
    );
  }
}
