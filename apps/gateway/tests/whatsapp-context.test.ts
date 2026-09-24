import { expect, it } from 'vitest';
import { contextOf } from '../src/channels/whatsapp/driver.js';
import { describeWhatsApp, readWhatsAppContent } from '../src/channels/whatsapp/media.js';

it('reads who a sticker answers, as it does a text', () => {
  const sticker = {
    key: { id: 'sticker', remoteJid: '120363000000000000@g.us' },
    message: {
      stickerMessage: {
        mimetype: 'image/webp',
        contextInfo: {
          stanzaId: 'agent-message',
          participant: '5571900000000@s.whatsapp.net',
          quotedMessage: { conversation: 'Your code is 90% honest.' },
        },
      },
    },
  };

  expect(contextOf(sticker)).toMatchObject({
    stanzaId: 'agent-message',
    participant: '5571900000000@s.whatsapp.net',
  });
  expect(describeWhatsApp(contextOf(sticker)?.quotedMessage)).toBe('Your code is 90% honest.');
});

it('names a sticker, a voice note and a file when they are quoted or sent bare', async () => {
  expect(describeWhatsApp({ stickerMessage: {} })).toBe('[Sticker]');
  expect(describeWhatsApp({ audioMessage: { ptt: true } })).toBe('[Voice message]');
  expect(describeWhatsApp({ documentMessage: { fileName: 'plan.pdf' } })).toBe('[File: plan.pdf]');

  const sent = await readWhatsAppContent(
    { key: { id: 'bare' }, message: { stickerMessage: { mimetype: 'image/webp' } } },
    async () => Buffer.from('webp'),
  );

  expect(sent.text).toBe('[Sticker]');
  expect(sent.media?.[0]?.mimeType).toBe('image/webp');
});
