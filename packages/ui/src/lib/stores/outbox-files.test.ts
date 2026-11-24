import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Attachment } from './drafts';
import { discard, resend, sendNow, useOutbox } from './outbox';

const file = (name: string): Attachment => ({
  key: `key-${name}`,
  name,
  kind: 'image',
  bytes: 1,
  state: 'ready',
  preview: `blob:${name}`,
  file: new File(['x'], name, { type: 'image/png' }),
  mimeType: 'image/png',
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const revoked = vi.fn();

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: revoked }));
});

afterEach(() => {
  for (const item of useOutbox.getState().items) discard(item.key);
  revoked.mockReset();
  vi.unstubAllGlobals();
});

it('puts the message in the conversation before its files are up, and sends it when they are', async () => {
  let finish: (media: { id: string }) => void = () => {};
  const upload = vi.fn(() => new Promise<{ id: string }>((resolve) => (finish = resolve)));
  const deliver = vi.fn(async () => ({ id: 'run' }));

  sendNow({
    sessionId: 'session',
    text: 'Look',
    mediaIds: [],
    attached: { files: [file('a.png')], upload },
    deliver,
    delivered: () => {},
  });
  await tick();

  const [item] = useOutbox.getState().items;
  expect(item).toMatchObject({ state: 'sending', text: 'Look' });
  expect(item?.files?.[0]?.preview).toBe('blob:a.png');
  expect(deliver).not.toHaveBeenCalled();

  finish({ id: 'media-a' });
  await tick();
  expect(deliver).toHaveBeenCalledWith(item?.key, ['media-a']);
  expect(useOutbox.getState().items[0]?.state).toBe('sent');
});

it('keeps a failed upload in the bubble, retries only what did not go up, under one key', async () => {
  const names: (string | undefined)[] = [];
  const upload = vi.fn(async ({ name }: { name?: string }) => {
    names.push(name);
    if (name === 'b.png' && names.filter((known) => known === 'b.png').length === 1) {
      throw new Error('Too big.');
    }
    return { id: `media-${name}` };
  });
  const deliver = vi.fn(async () => ({ id: 'run' }));
  sendNow({
    sessionId: 'session',
    text: '',
    mediaIds: [],
    attached: { files: [file('a.png'), file('b.png')], upload },
    deliver,
    delivered: () => {},
  });
  await tick();

  const [failed] = useOutbox.getState().items;
  expect(failed).toMatchObject({ state: 'failed', error: 'Could not upload b.png. Too big.' });
  expect(deliver).not.toHaveBeenCalled();

  resend(failed?.key ?? '');
  await tick();
  expect(names).toEqual(['a.png', 'b.png', 'b.png']);
  expect(deliver).toHaveBeenCalledOnce();
  expect(deliver).toHaveBeenCalledWith(failed?.key, ['media-a.png', 'media-b.png']);
});

it('lets the previews go with a message the owner discards', async () => {
  sendNow({
    sessionId: 'session',
    text: 'Look',
    mediaIds: [],
    attached: {
      files: [file('c.png')],
      upload: async () => {
        throw new Error('Offline.');
      },
    },
    deliver: async () => ({ id: 'run' }),
    delivered: () => {},
  });
  await tick();
  expect(revoked).not.toHaveBeenCalled();

  discard(useOutbox.getState().items[0]?.key ?? '');
  expect(revoked).toHaveBeenCalledWith('blob:c.png');
});
