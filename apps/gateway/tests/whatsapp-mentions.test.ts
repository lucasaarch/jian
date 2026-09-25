import { expect, it } from 'vitest';
import { withMentions } from '../src/channels/whatsapp/driver.js';

const people = [
  { id: '5571900000001@c.us', name: 'Ana' },
  { id: '5571900000002@c.us', name: 'Ana Paula' },
  { id: '140000000000003@lid', name: 'Rui (work)' },
];

it('turns a name into the number WhatsApp marks, and lists who it marks', () => {
  expect(withMentions('@Ana Paula, can you check what @ana sent?', people)).toEqual({
    text: '@5571900000002, can you check what @5571900000001 sent?',
    mentions: ['5571900000002@s.whatsapp.net', '5571900000001@s.whatsapp.net'],
  });
});

it('marks someone known only by a private address, and a name with symbols in it', () => {
  expect(withMentions('Thanks @Rui (work)!', people)).toEqual({
    text: 'Thanks @140000000000003!',
    mentions: ['140000000000003@lid'],
  });
});

it('leaves a longer word, an unknown name and an address without the @ alone', () => {
  const text = '@Anabela and @Carla wrote to ana@example.com';

  expect(withMentions(text, people)).toEqual({ text, mentions: [] });
});

it('marks a number the agent already wrote when it belongs to someone in the group', () => {
  expect(withMentions('@5571900000001 and @5571900000009', people)).toEqual({
    text: '@5571900000001 and @5571900000009',
    mentions: ['5571900000001@s.whatsapp.net'],
  });
});

it('marks by LID in a room that addresses people so, even when the agent wrote the phone', () => {
  const room = [{ id: '140000000000004@lid', name: 'Hel', alias: '5571900000004@c.us' }];

  expect(withMentions('@Hel and @5571900000004, check this', room)).toEqual({
    text: '@140000000000004 and @140000000000004, check this',
    mentions: ['140000000000004@lid'],
  });
});
