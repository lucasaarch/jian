import type { InspectionCapture } from '@jian/browser-core';
import {
  browserActionInputSchema,
  nativeBrowserActSchema,
  nativeBrowserRequestSchema,
  pageInspectionInputSchema,
} from '@jian/contracts';
import { expect, it } from 'vitest';
import { nativeBrowser } from '../src/web/native.js';

function bridge() {
  let receive: ((message: { data: unknown }) => void) | undefined;
  const sent: unknown[] = [];
  const browser = nativeBrowser({
    postMessage: (message) => {
      sent.push(message);
    },
    on: (_event, listener) => {
      receive = listener;
    },
  });
  return {
    inspect: browser.inspect,
    act: browser.act,
    sent,
    reply: (data: unknown) => receive?.({ data }),
  };
}
const scope = {
  profileId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
};

it('round-trips a browser action with its scope and its screenshot bytes', async () => {
  const host = bridge();
  const input = browserActionInputSchema.parse({ action: 'click', selector: '#menu' });
  const request = host.act(input, scope, new AbortController().signal);
  const message = nativeBrowserActSchema.parse(host.sent[0]);
  expect(message).toMatchObject({ type: 'browser:act', ...scope, input: { action: 'click' } });
  host.reply({
    type: 'browser:result',
    id: message.id,
    acted: {
      url: 'https://example.test/',
      title: 'Atlas',
      viewport: { width: 800, height: 600 },
      visible: true,
      screenshot: Buffer.from('shot').toString('base64'),
      frames: [],
    },
  });
  const acted = await request;
  expect(acted.url).toBe('https://example.test/');
  expect(acted.screenshot?.toString()).toBe('shot');
});

it('reports a page out of reach as the agent can read it', async () => {
  const host = bridge();
  const request = host.act(
    browserActionInputSchema.parse({ action: 'read' }),
    scope,
    new AbortController().signal,
  );
  const message = nativeBrowserActSchema.parse(host.sent[0]);
  host.reply({ type: 'browser:result', id: message.id, error: 'Jian Browser is not on screen' });
  await expect(request).rejects.toThrow('not on screen');
});

it('refuses an action that lacks what it needs before it reaches the browser', () => {
  for (const input of [
    { action: 'open' },
    { action: 'click' },
    { action: 'click', x: 10 },
    { action: 'type' },
    { action: 'key' },
    { action: 'open', url: 'not a url' },
  ])
    expect(browserActionInputSchema.safeParse(input).success).toBe(false);
});

it('round-trips an inspection with only the profile/session scope and retains image and export bytes', async () => {
  const host = bridge();
  const request = host.inspect(
    pageInspectionInputSchema.parse({ url: 'https://example.test' }),
    scope,
    new AbortController().signal,
  );
  const message = nativeBrowserRequestSchema.parse(host.sent[0]);
  expect(message).toMatchObject({
    type: 'browser:inspect',
    ...scope,
    input: { url: 'https://example.test' },
  });
  const snapshot = { url: 'https://example.test', title: 'Atlas' } as InspectionCapture['snapshot'];
  host.reply({
    type: 'browser:result',
    id: message.id,
    capture: {
      screenshot: Buffer.from('image').toString('base64'),
      archive: Buffer.from('archive').toString('base64'),
      snapshot,
    },
  });
  const result = await request;
  expect(Buffer.from(result.screenshot).toString()).toBe('image');
  expect(Buffer.from(result.archive).toString()).toBe('archive');
  expect(result.snapshot).toEqual(snapshot);
});

it('cancels only its own request, ignores late replies, and keeps another concurrent request intact', async () => {
  const host = bridge();
  const first = new AbortController();
  const input = pageInspectionInputSchema.parse({ url: 'https://example.test' });
  const cancelled = host.inspect(input, scope, first.signal);
  const rejection = expect(cancelled).rejects.toThrow('cancelled');
  const active = host.inspect(input, scope, new AbortController().signal);
  const one = nativeBrowserRequestSchema.parse(host.sent[0]);
  const two = nativeBrowserRequestSchema.parse(host.sent[1]);
  first.abort();
  await rejection;
  expect(host.sent[2]).toEqual({ type: 'browser:cancel', id: one.id });
  host.reply({ type: 'browser:result', id: one.id, error: 'Late reply' });
  host.reply({ type: 'browser:result', id: two.id, error: 'The page requires login' });
  await expect(active).rejects.toThrow('requires login');
});
