import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { type InlineMedia, ingressSchema, whatsappBusinessInputSchema } from '@jian/contracts';
import sharp from 'sharp';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { Channel, DeliveryContext, DeliveryOutcome, OutgoingMessage } from './channel.js';

export type MetaCredentials = z.infer<typeof whatsappBusinessInputSchema>;
export const META_GRAPH = 'https://graph.facebook.com/v25.0';
export const META_MEDIA_LIMIT = 16 * 1024 * 1024;
export const META_WINDOW_MS = 24 * 60 * 60 * 1000;
const digits = z.string().regex(/^\d{1,40}$/);
const remoteId = z.string().min(1).max(200);
const messageSchema = z.object({
  id: remoteId,
  from: digits,
  timestamp: z.string().regex(/^\d{1,12}$/),
  type: z.string().max(80),
  text: z.object({ body: z.string().max(8000) }).optional(),
  audio: z.object({ id: digits, mime_type: z.string().max(120).optional() }).optional(),
  image: z
    .object({
      id: digits,
      mime_type: z.string().max(120).optional(),
      caption: z.string().max(8000).optional(),
      sha256: z.string().max(128).optional(),
    })
    .optional(),
  context: z.object({ id: remoteId.optional() }).optional(),
  // Do not silently turn a Groups API event into an individual conversation.
  group_id: z.unknown().optional(),
});
export type MetaMessage = z.infer<typeof messageSchema>;
export const metaWebhookSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.object({
        id: digits,
        changes: z
          .array(
            z.object({
              field: z.string().max(100),
              value: z.object({
                group_id: z.unknown().optional(),
                metadata: z.object({ phone_number_id: digits }).optional(),
                contacts: z
                  .array(
                    z.object({
                      wa_id: digits,
                      profile: z.object({ name: z.string().max(100) }).optional(),
                    }),
                  )
                  .max(1000)
                  .optional(),
                messages: z.array(messageSchema).max(1000).optional(),
                statuses: z
                  .array(
                    z.object({
                      id: remoteId,
                      recipient_id: digits,
                      status: z.enum(['sent', 'delivered', 'read', 'failed']),
                      timestamp: z.string().regex(/^\d{1,12}$/),
                    }),
                  )
                  .max(1000)
                  .optional(),
              }),
            }),
          )
          .max(1000),
      }),
    )
    .max(1000),
});

export function metaSignature(raw: Buffer, signature: unknown, secret: string): boolean {
  if (typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(
    Buffer.from(signature.slice(7), 'hex'),
    createHmac('sha256', secret).update(raw).digest(),
  );
}

export function metaCredentials(value: string | undefined): MetaCredentials {
  if (!value) throw new Error('Meta credentials are unavailable');
  return whatsappBusinessInputSchema.parse(JSON.parse(value));
}

export function windowOpen(lastInbound: Date | undefined, now = Date.now()): boolean {
  return (
    !!lastInbound && lastInbound.getTime() <= now && now - lastInbound.getTime() < META_WINDOW_MS
  );
}

export async function graph(
  fetcher: typeof fetch,
  credentials: MetaCredentials,
  path: string,
  init: RequestInit,
  signal: AbortSignal,
) {
  return fetcher(`${META_GRAPH}/${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${credentials.accessToken}` },
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
}

/** Both the account edge and the phone object must be accessible before storing the binding. */
export async function verifyMetaNumber(
  credentials: MetaCredentials,
  fetcher: typeof fetch,
  signal: AbortSignal,
) {
  const response = await graph(
    fetcher,
    credentials,
    `${credentials.businessAccountId}/phone_numbers?fields=id&limit=100`,
    {},
    signal,
  );
  if (!response.ok) throw new GatewayError(400, 'Meta refused the account or access token');
  const result = z.object({ data: z.array(z.object({ id: digits })) }).parse(await response.json());
  if (!result.data.some((phone) => phone.id === credentials.phoneNumberId)) {
    throw new GatewayError(
      400,
      'Meta did not confirm that this phone number belongs to this business account',
    );
  }
  const phone = await graph(
    fetcher,
    credentials,
    `${credentials.phoneNumberId}?fields=id`,
    {},
    signal,
  );
  if (
    !phone.ok ||
    z.object({ id: digits }).parse(await phone.json()).id !== credentials.phoneNumberId
  ) {
    throw new GatewayError(400, 'Meta refused access to this phone number');
  }
}

/** Only known Meta CDN hosts can receive the bearer token; redirects are never followed. */
export function metaMediaUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname === 'lookaside.fbsbx.com' || url.hostname === 'graph.facebook.com')
  ) {
    throw new Error('Untrusted Meta media URL');
  }
  return url;
}

async function bounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error('Media download failed');
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel();
    throw new Error('Media exceeds 16 MB');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Media exceeds 16 MB');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** The prototype accepts only Ogg/Opus mono, not a file merely labelled audio/ogg. */
export function opusMono(bytes: Buffer): boolean {
  if (bytes.length < 47 || bytes.subarray(0, 4).toString() !== 'OggS') return false;
  const segments = bytes[26] ?? 0;
  const header = 27 + segments;
  return (
    segments === 1 &&
    bytes[27] === 19 &&
    bytes[4] === 0 &&
    bytes.length >= header + 19 &&
    bytes[header + 8] === 1 &&
    bytes.subarray(header, header + 8).toString() === 'OpusHead' &&
    bytes[header + 9] === 1
  );
}

export class WhatsAppBusinessChannel implements Channel {
  readonly type = 'whatsapp-business' as const;

  receive(payload: unknown) {
    const message = messageSchema.parse(payload);
    if (
      message.group_id !== undefined ||
      !['text', 'audio', 'image'].includes(message.type) ||
      (message.type === 'image' && !message.image)
    )
      return null;
    return ingressSchema.parse({
      actorId: message.from,
      chatId: message.from,
      text:
        message.type === 'audio'
          ? '[Voice message]'
          : message.type === 'image'
            ? message.image?.caption?.trim() || '[Photo]'
            : message.text?.body?.trim(),
      requestKey: `meta:${createHash('sha256').update(message.id).digest('hex')}`,
      ...(message.context?.id ? { target: message.context.id } : {}),
    });
  }

  async download(
    payload: unknown,
    context: DeliveryContext,
  ): Promise<{ media?: InlineMedia[]; note?: string }> {
    const message = messageSchema.parse(payload);
    const attachment =
      message.type === 'audio'
        ? message.audio
        : message.type === 'image'
          ? message.image
          : undefined;
    if (!attachment) return {};
    try {
      const credentials = metaCredentials(context.credential);
      const response = await graph(context.fetch, credentials, attachment.id, {}, context.signal);
      if (!response.ok) throw new Error('Media lookup failed');
      const metadata = z
        .object({
          url: z.string().max(4000),
          file_size: z.number().int().nonnegative(),
          sha256: z.string().optional(),
          mime_type: z.string().max(120).optional(),
        })
        .parse(await response.json());
      if (metadata.file_size > META_MEDIA_LIMIT) throw new Error('Media exceeds 16 MB');
      const url = metaMediaUrl(metadata.url);
      const result = await context.fetch(url, {
        headers: { authorization: `Bearer ${credentials.accessToken}` },
        redirect: 'error',
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]),
      });
      const bytes = await bounded(result, META_MEDIA_LIMIT);
      if (
        metadata.sha256 &&
        createHash('sha256').update(bytes).digest('hex') !== metadata.sha256.toLowerCase() &&
        createHash('sha256').update(bytes).digest('base64') !== metadata.sha256
      )
        throw new Error('Media hash mismatch');
      if (message.type === 'image') {
        if (bytes.length !== metadata.file_size) throw new Error('Media size mismatch');
        if (message.image?.sha256) {
          const hash = createHash('sha256').update(bytes);
          if (
            hash.copy().digest('hex') !== message.image.sha256.toLowerCase() &&
            hash.digest('base64') !== message.image.sha256
          )
            throw new Error('Media hash mismatch');
        }
        // Metadata alone accepts truncated files. Decode as well, with a pixel ceiling,
        // before giving any sender-supplied bytes to the shared vision pipeline.
        const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
        const { format } = await image.metadata();
        const mimeType =
          format === 'jpeg'
            ? 'image/jpeg'
            : format === 'png'
              ? 'image/png'
              : format === 'webp'
                ? 'image/webp'
                : format === 'gif'
                  ? 'image/gif'
                  : undefined;
        if (!mimeType) throw new Error('Unsupported image format');
        const contentType = result.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        for (const reported of [
          attachment.mime_type,
          metadata.mime_type,
          contentType === 'application/octet-stream' ? undefined : contentType,
        ]) {
          if (reported && reported !== mimeType) throw new Error('Image MIME mismatch');
        }
        await image.stats();
        return { media: [{ mimeType, data: bytes.toString('base64') }] };
      }
      if (!opusMono(bytes)) throw new Error('Only Ogg/Opus mono voice messages are supported');
      return { media: [{ mimeType: 'audio/ogg', data: bytes.toString('base64'), voice: true }] };
    } catch {
      return {
        note:
          message.type === 'image'
            ? '[The image could not be downloaded or was not a supported image within 16 MB. Ask the sender to send it again.]'
            : '[Audio could not be downloaded or was not a supported Ogg/Opus mono voice message.]',
      };
    }
  }

  async send(message: OutgoingMessage, context: DeliveryContext): Promise<DeliveryOutcome> {
    const failed: DeliveryOutcome = {
      status: 'failed',
      remoteMessageIds: [],
      error: 'WhatsApp Business supports only individual text and Ogg/Opus mono audio replies.',
    };
    const expired: DeliveryOutcome = {
      status: 'failed',
      remoteMessageIds: [],
      error:
        'WhatsApp Business requires a message from this recipient within the last 24 hours. Templates and sends outside this window are not supported.',
    };
    if (!/^\d{1,40}$/.test(message.chatId)) return failed;
    if (!(await context.canReply?.(message.chatId))) return expired;
    const credentials = metaCredentials(context.credential);
    let payload: Record<string, unknown>;
    if (message.media) {
      const bytes = Buffer.from(message.media.data, 'base64');
      if (
        message.media.mimeType !== 'audio/ogg' ||
        bytes.length > META_MEDIA_LIMIT ||
        !opusMono(bytes)
      )
        return failed;
      const form = new FormData();
      form.set('messaging_product', 'whatsapp');
      form.set('type', 'audio/ogg');
      form.set('file', new Blob([new Uint8Array(bytes)], { type: 'audio/ogg' }), 'voice.ogg');
      // An upload is not a message write: a timeout here cannot have delivered anything.
      let upload: Response;
      try {
        upload = await graph(
          context.fetch,
          credentials,
          `${credentials.phoneNumberId}/media`,
          { method: 'POST', body: form },
          context.signal,
        );
      } catch {
        return failed;
      }
      if (!upload.ok) return failed;
      const media = z.object({ id: digits }).safeParse(await upload.json());
      if (!media.success) return failed;
      payload = { type: 'audio', audio: { id: media.data.id, voice: true } };
    } else {
      if (!message.text.trim() || message.text.length > 4096) return failed;
      payload = { type: 'text', text: { body: message.text, preview_url: false } };
    }
    if (!(await context.canReply?.(message.chatId))) return expired;
    try {
      const response = await graph(
        context.fetch,
        credentials,
        `${credentials.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: message.chatId,
            ...payload,
          }),
        },
        context.signal,
      );
      if (response.status >= 400 && response.status < 500)
        return { ...failed, error: `Meta refused this message (HTTP ${response.status}).` };
      if (!response.ok) return { status: 'unknown', remoteMessageIds: [] };
      const result = z
        .object({ messages: z.array(z.object({ id: remoteId })).min(1) })
        .safeParse(await response.json());
      return result.success
        ? { status: 'sent', remoteMessageIds: result.data.messages.map((item) => item.id) }
        : { status: 'unknown', remoteMessageIds: [] };
    } catch {
      return { status: 'unknown', remoteMessageIds: [] };
    }
  }
}
