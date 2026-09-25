import type { Run } from '@jian/contracts';
import { expect, it } from 'vitest';
import { listDeliveries } from '../src/channels/repository.js';
import { Channels } from '../src/channels/service.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { outgoingMedia } from '../src/channels/whatsapp/driver.js';
import { readWhatsAppContent } from '../src/channels/whatsapp/media.js';
import { Stickers } from '../src/stickers/service.js';
import { testServices } from './helpers/services.js';

const webp = (tag: string) => Buffer.from(`RIFF-webp-${tag}`).toString('base64');

async function collection() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const described: string[] = [];
  const descriptions: Record<string, { description: string; tags: string[] }> = {
    [webp('laugh')]: {
      description: 'A tree stump laughing so hard it cries',
      tags: ['laughing', 'funny', 'tree'],
    },
    [webp('thumbs')]: {
      description: 'A cat giving a thumbs up',
      tags: ['approval', 'ok', 'cat'],
    },
  };
  const stickers = new Stickers(services.store, {
    describeSticker: async (_profileId, data) => {
      described.push(data);

      return descriptions[data] ?? { description: '', tags: [] };
    },
    sendSticker: (run, data, toolCallId) => services.media.sendSticker(run, data, toolCallId),
  });

  return { services, profile, stickers, described };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

it('keeps each sticker once, counts it each time, and finds it by tag, meaning or popularity', async () => {
  const f = await collection();
  const keep = (tag: string) =>
    f.stickers.keep(f.profile.id, { mimeType: 'image/webp', data: webp(tag), sticker: true });

  await keep('laugh');
  await keep('laugh');
  await keep('laugh');
  await keep('thumbs');
  // A photo is not a sticker, whatever flag it carries.
  await f.stickers.keep(f.profile.id, {
    mimeType: 'image/png',
    data: webp('photo'),
    sticker: true,
  });
  await settle();

  const kept = await f.stickers.list(f.profile.id);

  expect(kept).toHaveLength(2);
  expect(f.described).toHaveLength(2);
  expect(kept.find((sticker) => sticker.tags.includes('funny'))?.seen).toBe(3);

  const [byMeaning] = await f.stickers.search(f.profile.id, { query: 'something laughing' });
  const [byTag] = await f.stickers.search(f.profile.id, { tag: 'ok' });
  const [popular] = await f.stickers.search(f.profile.id, { order: 'most_seen' });

  expect(byMeaning?.shows).toBe('A tree stump laughing so hard it cries');
  expect(byTag?.tags).toEqual(['approval', 'ok', 'cat']);
  expect(popular?.seen).toBe(3);
  expect(await f.stickers.search(f.profile.id, { query: 'crying baby' })).toEqual([]);

  const retagged = await f.stickers.tag(f.profile.id, byTag?.id as string, {
    tags: ['Deal', 'done here'],
  });

  expect(retagged.tags).toEqual(['deal', 'done here']);

  const removed = await f.stickers.forget(f.profile.id, byMeaning?.id as string);

  expect(removed.description).toContain('laughing');
  expect(await f.stickers.list(f.profile.id)).toHaveLength(1);
});

it('sends a sticker as a sticker, on the chat the conversation is on', async () => {
  const f = await collection();
  const channels = new Channels(f.services, fetch);
  const channel = await channels.connect(f.profile.id, { type: 'api' });

  await channels.receive(channel.id, {
    type: 'api',
    headers: { 'x-jian-channel-token': channel.webhookToken },
    payload: {
      actorId: 'rowan',
      chatId: 'rowan',
      text: '[Sticker]',
      requestKey: 'sticker',
      media: [{ mimeType: 'image/webp', data: webp('thumbs'), sticker: true }],
    },
  });

  const [contact] = await channels.contacts(f.profile.id);
  if (!contact) throw new Error('Missing contact');
  await channels.approveContact(f.profile.id, contact.id);
  const [run] = await f.services.runs.recent(f.profile.id);
  const [kept] = await f.stickers.list(f.profile.id);

  // Not kept from a stranger; the approval releases the message, not the sticker.
  expect(kept).toBeUndefined();

  await f.stickers.keep(f.profile.id, {
    mimeType: 'image/webp',
    data: webp('thumbs'),
    sticker: true,
  });
  const [sticker] = await f.stickers.list(f.profile.id);
  const send = f.stickers.tools(run as Run).send_sticker;

  await send?.execute?.(
    { stickerId: sticker?.id as string },
    { toolCallId: 'send', messages: [], context: {} },
  );

  const delivery = (await listDeliveries(f.services.store.db, f.profile.id)).find(
    (item) => item.mediaId,
  );
  const media = await f.services.media.read(f.profile.id, delivery?.mediaId as string);

  expect(media).toMatchObject({ mimeType: 'image/webp', sticker: true, data: webp('thumbs') });
  expect((await f.stickers.list(f.profile.id))[0]?.uses).toBe(1);
});

it('reads a sticker as one on WhatsApp and Telegram, and sends it back as one', async () => {
  const whatsapp = await readWhatsAppContent(
    { key: { id: 'sticker' }, message: { stickerMessage: { mimetype: 'image/webp' } } },
    async () => Buffer.from('webp'),
  );

  expect(whatsapp.media?.[0]).toMatchObject({ mimeType: 'image/webp', sticker: true });
  expect(
    outgoingMedia({ mimeType: 'image/webp', data: webp('x'), sticker: true }, 'ignored'),
  ).toEqual({ sticker: Buffer.from(webp('x'), 'base64') });

  const telegram = new TelegramChannel();
  const update = {
    update_id: 9,
    message: {
      from: { id: 11 },
      chat: { id: 11, type: 'private' },
      sticker: { file_id: 'sticker-1', emoji: '😂', is_animated: false, is_video: false },
    },
  };

  expect(telegram.receive(update)?.text).toBe('[Sticker 😂]');

  const called: string[] = [];
  const context = {
    channelId: 'telegram',
    credential: '123:synthetic_token',
    fetch: (async (url: string | URL) => {
      const address = String(url);

      called.push(address.split('/').at(-1) ?? '');
      if (address.endsWith('/getFile'))
        return Response.json({ ok: true, result: { file_path: 'stickers/file_1.webp' } });
      if (address.includes('/file/')) return new Response('webp');

      return Response.json({ ok: true, result: { message_id: 3 } });
    }) as typeof fetch,
    signal: AbortSignal.timeout(1000),
  };

  expect((await telegram.download(update, context)).media?.[0]).toMatchObject({
    mimeType: 'image/webp',
    sticker: true,
  });

  await telegram.send(
    { chatId: '11', text: '', media: { mimeType: 'image/webp', data: webp('x'), sticker: true } },
    context,
  );

  expect(called.at(-1)).toBe('sendSticker');
});

it('reads the model catalogue entry, fenced, bare or as prose', async () => {
  const { readSticker } = await import('../src/media/service.js');

  expect(
    readSticker('```json\n{"description":"A dog shrugging","tags":["Shrug","unsure","dog!"]}\n```'),
  ).toEqual({ description: 'A dog shrugging', tags: ['shrug', 'unsure'] });
  expect(readSticker('A dog shrugging, unsure')).toEqual({
    description: 'A dog shrugging, unsure',
    tags: [],
  });
});
