import { createHash, createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { Channels } from '../src/channels/service.js';
import { META_MEDIA_LIMIT, WhatsAppBusinessChannel } from '../src/channels/whatsapp-business.js';
import { mediaAssets, metaInbox } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const credentials = {
  accessToken: 'synthetic-image-token',
  appSecret: 'synthetic-image-secret',
  verifyToken: 'synthetic-image-verify',
  phoneNumberId: '12345',
  businessAccountId: '67890',
};
const cdn = 'https://lookaside.fbsbx.com/image';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const photo = (id = 'photo', caption?: string) => ({
  id,
  from: '15550000001',
  timestamp: String(Math.floor(Date.now() / 1000)),
  type: 'image',
  image: { id: '333', mime_type: 'image/png', ...(caption === undefined ? {} : { caption }) },
});
const batch = (messages: unknown[]) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: credentials.businessAccountId,
      changes: [
        {
          field: 'messages',
          value: { metadata: { phone_number_id: credentials.phoneNumberId }, messages },
        },
      ],
    },
  ],
});
const png = () =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
const context = (fetcher: typeof fetch) => ({
  channelId: 'channel',
  credential: JSON.stringify(credentials),
  fetch: fetcher,
  signal: new AbortController().signal,
});

async function setup() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Images',
    instructions: 'Help',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const bytes = await png();
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes('/phone_numbers?')) return Response.json({ data: [{ id: '12345' }] });
    if (String(url).endsWith('/12345?fields=id')) return Response.json({ id: '12345' });
    if (String(url).endsWith('/333'))
      return Response.json({
        url: cdn,
        file_size: bytes.length,
        mime_type: 'image/png',
        sha256: hash(bytes),
      });
    if (String(url) === cdn)
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } });
    if (String(url).endsWith('/messages'))
      return Response.json({ messages: [{ id: 'wamid.out' }] });
    throw new Error('Unexpected external request');
  });
  const channels = new Channels(services, fetcher);
  const channel = await channels.connect(profile.id, {
    type: 'whatsapp-business',
    whatsappBusiness: credentials,
  });
  await channels.update(profile.id, channel.id, { allowAllContacts: true });
  const app = createApp({
    ...services,
    channels,
    token: 'synthetic-admin-token-at-least-32-characters',
    logger: false,
  });
  const post = (value: unknown, signature?: string) => {
    const payload = JSON.stringify(value);
    return app.inject({
      method: 'POST',
      url: `/v1/whatsapp-business/${channel.id}`,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256':
          signature ??
          `sha256=${createHmac('sha256', credentials.appSecret).update(payload).digest('hex')}`,
      },
      payload,
    });
  };
  return {
    services,
    profile,
    channels,
    channel,
    fetcher,
    bytes,
    post,
    close: async () => {
      await channels.stop();
      await app.close();
    },
  };
}

describe('Meta incoming images', () => {
  it.each(['What is in this picture?', undefined])(
    'signed webhook stages image and caption %s in a run, deduplicating retries',
    async (caption) => {
      const f = await setup();
      try {
        const payload = batch([photo('image-with-caption', caption)]);
        expect((await f.post(payload)).statusCode).toBe(200);
        await f.channels.dispatch();
        const [asset] = await f.services.store.db.select().from(mediaAssets);
        const [run] = await f.services.runs.activities(f.profile.id);
        expect(asset).toMatchObject({
          mimeType: 'image/png',
          bytes: f.bytes.length,
          sessionId: run?.sessionId,
        });
        expect(run?.input).toContain(caption ?? '[Photo]');
        expect(run?.input).toContain(asset?.id);
        expect(Buffer.from(asset?.data ?? '', 'base64')).toEqual(f.bytes);
        const requests = f.fetcher.mock.calls.length;
        await f.post(payload);
        await f.channels.dispatch();
        expect(f.fetcher.mock.calls).toHaveLength(requests);
        // Replay after intake committed but before the inbox was acknowledged.
        await f.services.store.db
          .update(metaInbox)
          .set({ processedAt: null, availableAt: new Date(0) });
        await f.channels.dispatch();
        expect(await f.services.store.db.select().from(mediaAssets)).toHaveLength(1);
        expect(await f.services.runs.activities(f.profile.id)).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );

  it('keeps download failure visible in the run along with its caption', async () => {
    const f = await setup();
    try {
      const original = f.fetcher.getMockImplementation();
      f.fetcher.mockImplementation(async (url, init) => {
        if (String(url).endsWith('/333')) return new Response(null, { status: 503 });
        if (!original) throw new Error('Missing fetcher');
        return original(url, init);
      });
      await f.post(batch([photo('failed', 'Please inspect this')]));
      await f.channels.dispatch();
      const [run] = await f.services.runs.activities(f.profile.id);
      expect(run?.input).toContain('Please inspect this');
      expect(run?.input).toContain('image could not be downloaded');
      expect(await f.services.store.db.select().from(mediaAssets)).toHaveLength(0);
      expect((await f.services.store.db.select().from(metaInbox))[0]?.processedAt).not.toBeNull();
    } finally {
      await f.close();
    }
  });

  it('stages an unapproved sender image and binds it to the approved session', async () => {
    const f = await setup();
    try {
      await f.channels.update(f.profile.id, f.channel.id, { allowAllContacts: false });
      await f.post(batch([photo('pending', 'Held picture')]));
      await f.channels.dispatch();
      const [contact] = await f.channels.contacts(f.profile.id);
      if (!contact) throw new Error('Missing contact');
      const [held] = await f.services.store.db.select().from(mediaAssets);
      expect(held?.contactId).toBe(contact.id);
      expect(held?.sessionId).toBeNull();
      await f.channels.approveContact(f.profile.id, contact.id);
      const [bound] = await f.services.store.db.select().from(mediaAssets);
      const [run] = await f.services.runs.activities(f.profile.id);
      expect(bound?.sessionId).toBe(run?.sessionId);
      expect(run?.input).toContain('Held picture');
      expect(run?.input).toContain(bound?.id);
    } finally {
      await f.close();
    }
  });

  it('does not download paused-channel images or replay them on resume', async () => {
    const f = await setup();
    try {
      await f.post(batch([photo('queued')]));
      await f.channels.update(f.profile.id, f.channel.id, { enabled: false });
      await f.post(batch([photo('paused')]));
      f.fetcher.mockClear();
      await f.channels.dispatch();
      await f.channels.update(f.profile.id, f.channel.id, { enabled: true });
      await f.channels.dispatch();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(await f.services.runs.activities(f.profile.id)).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it('checks per-chat pause before downloading, including images queued before pause', async () => {
    const f = await setup();
    try {
      await f.post(batch([photo('initial')]));
      await f.channels.dispatch();
      const [contact] = await f.channels.contacts(f.profile.id);
      if (!contact) throw new Error('Missing contact');
      await f.post(batch([photo('queued')]));
      await f.channels.updateContact(f.profile.id, contact.id, { aiEnabled: false });
      await f.post(batch([photo('paused')]));
      f.fetcher.mockClear();
      await f.channels.dispatch();
      await f.channels.updateContact(f.profile.id, contact.id, { aiEnabled: true });
      await f.channels.dispatch();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(await f.services.store.db.select().from(mediaAssets)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('rejects unsigned input and ignores groups and missing image objects without download', async () => {
    const f = await setup();
    try {
      expect((await f.post(batch([photo()]), `sha256=${'0'.repeat(64)}`)).statusCode).toBe(401);
      await f.post(
        batch([
          { ...photo('group'), group_id: 'group' },
          { ...photo('missing'), image: undefined },
        ]),
      );
      f.fetcher.mockClear();
      await f.channels.dispatch();
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(
        await f.services.store.db
          .select()
          .from(metaInbox)
          .where(eq(metaInbox.channelId, f.channel.id)),
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
});

describe('Meta image download boundaries', () => {
  it.each(['jpeg', 'png', 'webp', 'gif'] as const)(
    'detects and decodes real %s bytes without relying on MIME declarations',
    async (format) => {
      const bytes = await sharp(await png())
        .toFormat(format)
        .toBuffer();
      const fetcher = vi.fn<typeof fetch>(async (url) =>
        String(url) === cdn
          ? new Response(new Uint8Array(bytes), {
              headers: { 'content-type': 'application/octet-stream' },
            })
          : Response.json({ url: cdn, file_size: bytes.length }),
      );
      const result = await new WhatsAppBusinessChannel().download(
        { ...photo(), image: { id: '333' } },
        context(fetcher),
      );
      expect(result.media?.[0]).toEqual({
        mimeType: `image/${format}`,
        data: bytes.toString('base64'),
      });
    },
  );

  it('uses bearer auth only on allowlisted HTTPS hosts with no redirects and checks both hashes', async () => {
    const bytes = await png();
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url) === cdn
        ? new Response(new Uint8Array(bytes), {
            headers: { 'content-type': 'image/png; charset=binary' },
          })
        : Response.json({
            url: cdn,
            file_size: bytes.length,
            mime_type: 'image/png',
            sha256: hash(bytes),
          }),
    );
    const inbound = {
      ...photo(),
      image: { ...photo().image, sha256: createHash('sha256').update(bytes).digest('base64') },
    };
    const adapter = new WhatsAppBusinessChannel();
    expect((await adapter.download(inbound, context(fetcher))).media?.[0]?.mimeType).toBe(
      'image/png',
    );
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${credentials.accessToken}` });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(
      (
        await adapter.download(
          { ...inbound, image: { ...inbound.image, sha256: '0'.repeat(64) } },
          context(fetcher),
        )
      ).note,
    ).toBeTruthy();
  });

  it.each([
    'https://evil.example/image',
    'https://lookaside.fbsbx.com.evil.example/image',
    'http://lookaside.fbsbx.com/image',
    'https://user@lookaside.fbsbx.com/image',
  ])('never sends credentials to %s', async (url) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ url, file_size: 1 }));
    expect(
      (await new WhatsAppBusinessChannel().download(photo(), context(fetcher))).note,
    ).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    'forged-bytes',
    'webhook-mime',
    'metadata-mime',
    'http-mime',
    'hash',
    'size-mismatch',
    'truncated',
    'metadata-size',
    'header-size',
    'stream-size',
  ])('rejects %s without forwarding media', async (failure) => {
    const valid = await png();
    const bytes =
      failure === 'forged-bytes'
        ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
        : failure === 'truncated'
          ? valid.subarray(0, valid.length - 25)
          : valid;
    const inbound = photo();
    if (failure === 'webhook-mime') inbound.image.mime_type = 'image/jpeg';
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) !== cdn)
        return Response.json({
          url: cdn,
          file_size:
            failure === 'metadata-size'
              ? META_MEDIA_LIMIT + 1
              : failure === 'size-mismatch'
                ? bytes.length + 1
                : bytes.length,
          mime_type: failure === 'metadata-mime' ? 'image/jpeg' : 'image/png',
          sha256: failure === 'hash' ? '0'.repeat(64) : hash(bytes),
        });
      if (failure === 'stream-size')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(META_MEDIA_LIMIT));
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          }),
        );
      return new Response(new Uint8Array(bytes), {
        headers: {
          'content-type': failure === 'http-mime' ? 'image/jpeg' : 'image/png',
          ...(failure === 'header-size' ? { 'content-length': String(META_MEDIA_LIMIT + 1) } : {}),
        },
      });
    });
    const result = await new WhatsAppBusinessChannel().download(inbound, context(fetcher));
    expect(result.media).toBeUndefined();
    expect(result.note).toContain('image could not be downloaded');
    if (failure === 'metadata-size') expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
