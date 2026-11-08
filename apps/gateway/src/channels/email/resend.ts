import { fileNameOf, type InlineMedia, MAX_MEDIA_BYTES, mediaMimeOf } from '@jian/contracts';
import { z } from 'zod';
import { GatewayError } from '../../core/errors.js';
import { readMediaBody } from '../../media/providers.js';
import type { DeliveryOutcome } from '../channel.js';
import type { EmailProvider, Net, OutgoingEmail, ReceivedEmail } from './provider.js';
import { svixSigned } from './svix.js';

const API = 'https://api.resend.com';
const REQUEST_TIMEOUT_MS = 20_000;
/** The id lookup after a send only improves reply matching; it must not hold the outbox. */
const LOOKUP_TIMEOUT_MS = 5_000;
const FILE_TIMEOUT_MS = 30_000;
/** As many files as one incoming message may carry into a run. */
const MAX_FILES = 4;

const FILE_NOTE =
  '[An attachment could not be downloaded or exceeds 16 MB. Ask the sender to send it again in a smaller file.]';
const MORE_FILES_NOTE = `[Only the first ${MAX_FILES} attachments were kept.]`;

const id = z.string().min(1).max(200);
const addresses = z.array(z.string().max(320)).max(100).nullish();

const eventSchema = z.object({
  type: z.string().max(100),
  data: z.object({
    email_id: id.optional(),
    to: addresses,
    cc: addresses,
    received_for: addresses,
  }),
});

const receivedSchema = z.object({
  id,
  from: z.string().max(1000),
  to: addresses,
  cc: addresses,
  received_for: addresses,
  subject: z.string().max(2000).nullish(),
  text: z.string().nullish(),
  html: z.string().nullish(),
  headers: z.record(z.string(), z.unknown()).nullish(),
  message_id: z.string().max(1000).nullish(),
  authentication: z
    .object({
      spf: z.string().max(40).nullish(),
      dkim: z.string().max(40).nullish(),
      dmarc: z.string().max(40).nullish(),
    })
    .nullish(),
  attachments: z.array(z.unknown()).max(1000).nullish(),
});

const filesSchema = z.object({
  data: z
    .array(
      z.object({
        filename: z.string().max(500).nullish(),
        size: z.number().int().nonnegative().nullish(),
        content_type: z.string().max(200).nullish(),
        download_url: z.string().max(4000),
      }),
    )
    .max(1000),
});

const lower = (list: string[] | null | undefined) => (list ?? []).map((item) => item.toLowerCase());

/** A `Message-ID` as headers write it, in angle brackets, so ours and theirs compare equal. */
const bracketed = (value: string) => (value.startsWith('<') ? value : `<${value}>`);

/** Only Resend's own hosts are fetched, over HTTPS, without credentials and without redirects. */
export function resendFileUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname === 'resend.com' || url.hostname.endsWith('.resend.com'))
  ) {
    throw new Error('Untrusted attachment URL');
  }
  return url;
}

export class Resend implements EmailProvider {
  private call(
    apiKey: string,
    path: string,
    init: RequestInit,
    net: Net,
    timeout = REQUEST_TIMEOUT_MS,
  ) {
    return net.fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.any([net.signal, AbortSignal.timeout(timeout)]),
    });
  }

  /** Resend's own words for a refusal, kept short: it is shown to the owner as it is. */
  private async refusal(response: Response) {
    const body = await response.json().catch(() => undefined);
    const message = z.object({ message: z.string() }).safeParse(body);
    return message.success
      ? message.data.message.replace(/\s+/g, ' ').slice(0, 200)
      : `HTTP ${response.status}`;
  }

  async verify(apiKey: string, address: string, net: Net) {
    const domain = address.split('@')[1]?.toLowerCase();
    let response: Response;
    try {
      response = await this.call(apiKey, '/domains?limit=100', {}, net);
    } catch {
      throw new GatewayError(502, 'Resend could not be reached to check the API key. Try again.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new GatewayError(
        400,
        `Resend refused this API key (${await this.refusal(response)}). Use a key with full access.`,
      );
    }
    if (!response.ok) {
      throw new GatewayError(502, `Resend could not list your domains (HTTP ${response.status}).`);
    }
    const parsed = z
      .object({
        data: z.array(
          z.object({
            name: z.string(),
            status: z.string(),
            capabilities: z.object({ receiving: z.string().optional() }).partial().nullish(),
          }),
        ),
      })
      .safeParse(await response.json().catch(() => undefined));
    if (!parsed.success)
      throw new GatewayError(502, 'Resend answered the domain list unexpectedly.');
    const found = parsed.data.data.find((item) => item.name.toLowerCase() === domain);
    if (found?.status !== 'verified') {
      throw new GatewayError(400, `${domain} is not a verified domain in this Resend account.`);
    }
    const receiving = found.capabilities?.receiving;
    if (receiving !== undefined && receiving !== 'enabled') {
      throw new GatewayError(
        400,
        `${domain} cannot receive email in Resend yet. Enable receiving and add its MX record.`,
      );
    }
  }

  async subscribe(apiKey: string, endpoint: string, net: Net) {
    let response: Response;
    try {
      response = await this.call(
        apiKey,
        '/webhooks',
        { method: 'POST', body: JSON.stringify({ endpoint, events: ['email.received'] }) },
        net,
      );
    } catch {
      throw new GatewayError(
        502,
        'Resend could not be reached to register the webhook. Try again.',
      );
    }
    if (!response.ok) {
      throw new GatewayError(
        response.status >= 500 ? 502 : 400,
        `Resend refused the webhook ${endpoint}: ${await this.refusal(response)}`,
      );
    }
    const created = z
      .object({ id, signing_secret: z.string().min(1).max(500) })
      .safeParse(await response.json().catch(() => undefined));
    // Without the secret no event could be told from a forgery, so the channel cannot exist.
    if (!created.success) {
      throw new GatewayError(502, 'Resend registered the webhook without its signing secret.');
    }
    return { webhookId: created.data.id, signingSecret: created.data.signing_secret };
  }

  async unsubscribe(apiKey: string, webhookId: string, net: Net) {
    const path = `/webhooks/${encodeURIComponent(webhookId)}`;
    const response = await this.call(apiKey, path, { method: 'DELETE' }, net);
    // Already gone is what was asked for.
    if (!response.ok && response.status !== 404) {
      throw new GatewayError(502, `Resend did not remove the webhook (HTTP ${response.status})`);
    }
  }

  authentic(
    raw: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>,
    secret: string,
  ) {
    return svixSigned(raw, headers, secret);
  }

  event(payload: unknown) {
    const parsed = eventSchema.safeParse(payload);
    if (!parsed.success || parsed.data.type !== 'email.received' || !parsed.data.data.email_id)
      return undefined;
    const { data } = parsed.data;
    return {
      emailId: data.email_id as string,
      recipients: [...lower(data.to), ...lower(data.cc), ...lower(data.received_for)],
    };
  }

  async read(apiKey: string, emailId: string, net: Net): Promise<ReceivedEmail> {
    // `cid` keeps inline images as references; the default writes each one into the HTML.
    const response = await this.call(
      apiKey,
      `/emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`,
      {},
      net,
    );
    if (!response.ok) throw new Error(`Resend could not read the email (HTTP ${response.status})`);
    const email = receivedSchema.parse(await response.json());
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(email.headers ?? {})) {
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === 'string' && !(name.toLowerCase() in headers))
        headers[name.toLowerCase()] = first.slice(0, 4000);
    }
    const auth = email.authentication;
    return {
      id: email.id,
      from: email.from,
      to: lower(email.to),
      cc: lower(email.cc),
      receivedFor: lower(email.received_for),
      subject: email.subject ?? '',
      text: email.text,
      html: email.html,
      headers,
      ...(email.message_id ? { messageId: bracketed(email.message_id.trim()) } : {}),
      authentication: auth
        ? {
            ...(auth.spf ? { spf: auth.spf } : {}),
            ...(auth.dkim ? { dkim: auth.dkim } : {}),
            ...(auth.dmarc ? { dmarc: auth.dmarc } : {}),
          }
        : null,
      attachments: email.attachments?.length ?? 0,
    };
  }

  async attachments(apiKey: string, emailId: string, net: Net) {
    let files: z.infer<typeof filesSchema>['data'];
    try {
      const response = await this.call(
        apiKey,
        `/emails/receiving/${encodeURIComponent(emailId)}/attachments`,
        {},
        net,
      );
      if (!response.ok) return { note: FILE_NOTE };
      files = filesSchema.parse(await response.json()).data;
    } catch {
      return { note: FILE_NOTE };
    }

    const media: InlineMedia[] = [];
    let failed = false;
    for (const file of files.slice(0, MAX_FILES)) {
      try {
        if ((file.size ?? 0) > MAX_MEDIA_BYTES) throw new Error('Attachment too large');
        // The URL is signed on its own: the API key never leaves for another host.
        const response = await net.fetch(resendFileUrl(file.download_url), {
          redirect: 'error',
          signal: AbortSignal.any([net.signal, AbortSignal.timeout(FILE_TIMEOUT_MS)]),
        });
        if (!response.ok) throw new Error('Attachment download failed');
        const bytes = await readMediaBody(response, MAX_MEDIA_BYTES);
        if (!bytes.length) throw new Error('Empty attachment');
        const name = file.filename?.trim().slice(0, 200) || undefined;
        media.push({
          mimeType: mediaMimeOf(file.content_type, name),
          data: bytes.toString('base64'),
          ...(name ? { name } : {}),
        });
      } catch {
        failed = true;
      }
    }

    const notes = [
      ...(failed ? [FILE_NOTE] : []),
      ...(files.length > MAX_FILES ? [MORE_FILES_NOTE] : []),
    ];
    return {
      ...(media.length ? { media } : {}),
      ...(notes.length ? { note: notes.join('\n') } : {}),
    };
  }

  async send(
    apiKey: string,
    email: OutgoingEmail,
    idempotencyKey: string,
    net: Net,
  ): Promise<DeliveryOutcome> {
    const headers = {
      ...(email.inReplyTo ? { 'In-Reply-To': email.inReplyTo } : {}),
      ...(email.references ? { References: email.references } : {}),
    };
    const body = {
      from: email.from,
      to: [email.to],
      ...(email.cc?.length ? { cc: email.cc } : {}),
      subject: email.subject,
      text: email.text || ' ',
      ...(email.html ? { html: email.html } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      // Resend takes each file as base64, which is how the gateway keeps them already.
      ...(email.attachments?.length
        ? {
            attachments: email.attachments.map((file) => ({
              filename: file.name ?? fileNameOf(file.mimeType),
              content: file.data,
            })),
          }
        : {}),
    };

    let response: Response;
    try {
      response = await this.call(
        apiKey,
        '/emails',
        {
          method: 'POST',
          // Resend keeps the key for 24 hours: a send retried after a lost answer lands once.
          headers: { 'idempotency-key': idempotencyKey.slice(0, 256) },
          body: JSON.stringify(body),
        },
        net,
      );
    } catch {
      return { status: 'unknown', remoteMessageIds: [] };
    }

    // A rate limit is a refusal that names a wait, and the idempotency key makes the retry safe.
    if (response.status === 429) return { status: 'pending', remoteMessageIds: [] };
    if (response.status >= 400 && response.status < 500) {
      return {
        status: 'failed',
        remoteMessageIds: [],
        error: `Resend refused this email (HTTP ${response.status}).`,
      };
    }
    if (!response.ok) return { status: 'unknown', remoteMessageIds: [] };

    const sent = z.object({ id }).safeParse(await response.json().catch(() => undefined));
    if (!sent.success) return { status: 'unknown', remoteMessageIds: [] };

    // A reply names the `Message-ID` it answers, which Resend assigns and does not return on
    // send. Asked once, briefly: without it a reply is still read, only not tied to this email.
    const messageId = await this.call(
      apiKey,
      `/emails/${encodeURIComponent(sent.data.id)}`,
      {},
      net,
      LOOKUP_TIMEOUT_MS,
    )
      .then(async (found) =>
        found.ok
          ? z.object({ message_id: z.string().min(1).max(200) }).safeParse(await found.json()).data
              ?.message_id
          : undefined,
      )
      .catch(() => undefined);

    return {
      status: 'sent',
      remoteMessageIds: [sent.data.id, ...(messageId ? [bracketed(messageId.trim())] : [])],
    };
  }
}
