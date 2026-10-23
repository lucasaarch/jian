import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Channel, GatewayApi, NewChannel, ProfileData } from '../../lib/api';
import { profiles } from '../../stories/fixtures';
import { Channels } from '.';

vi.mock('./pairing', () => ({ Pairing: () => <p>QR pairing opened</p> }));

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function render(channels: Channel[] = [], fail = false) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const profile = profiles[0];
  if (!profile) throw new Error('Missing profile fixture');
  const createChannel = vi.fn(async (_profileId: string, body: NewChannel) => {
    if (fail) throw new Error('Synthetic save failure');
    return {
      id: 'meta-channel',
      profileId: profile.id,
      type: body.type,
      createdAt: '2026-10-23T12:00:00Z',
      allowAllContacts: false,
      webhookToken: 'synthetic-unused-ingress-token',
    };
  });
  const connect = vi.fn(async () => {});
  const api = { createChannel, connect } as unknown as GatewayApi;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  const mutate = vi.fn(async (action: () => Promise<unknown>, _success?: string) => {
    try {
      await action();
      return true;
    } catch {
      return false;
    }
  });
  await act(async () => {
    root.render(
      <Channels
        profile={profile}
        data={{ channels, contacts: [], groups: [] } as unknown as ProfileData}
        api={api}
        mutate={mutate}
        busy={false}
      />,
    );
  });
  const toggle = async (type: string) => {
    await act(async () =>
      element.querySelector<HTMLButtonElement>(`[aria-controls="channel-${type}"]`)?.click(),
    );
    const panel = element.querySelector<HTMLElement>(`#channel-${type}`);
    if (!panel) throw new Error('Missing channel panel');
    return panel;
  };
  return { element, createChannel, connect, mutate, toggle };
}

const credentials = {
  accessToken: 'synthetic-access-token',
  appSecret: 'synthetic-app-secret',
  verifyToken: 'synthetic-verify-secret',
  phoneNumberId: '123456',
  businessAccountId: '987654',
};

function fill(panel: HTMLElement) {
  for (const [name, value] of Object.entries(credentials)) {
    const input = panel.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (!input) throw new Error(`Missing ${name} field`);
    input.value = value;
  }
}

for (const fail of [false, true]) {
  it(`sends only Meta credentials and clears secrets on ${fail ? 'failed' : 'successful'} save`, async () => {
    const { toggle, createChannel, connect, element, mutate } = await render([], fail);
    const panel = await toggle('whatsapp-business');
    expect(panel.querySelectorAll('input[type="password"]')).toHaveLength(3);
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    fill(panel);
    await act(async () => {
      panel
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(createChannel).toHaveBeenCalledWith(profiles[0]?.id, {
      type: 'whatsapp-business',
      whatsappBusiness: credentials,
    });
    expect(connect).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    expect(panel.querySelector<HTMLInputElement>('[name="accessToken"]')?.value).toBe('');
    expect(panel.querySelector<HTMLInputElement>('[name="appSecret"]')?.value).toBe('');
    expect(panel.querySelector<HTMLInputElement>('[name="verifyToken"]')?.value).toBe('');
    expect(element.textContent).not.toContain('synthetic-unused-ingress-token');
    expect(document.body.textContent).not.toContain('Webhook configuration');
    expect(mutate.mock.calls[0]?.[1]).toContain('Complete webhook setup');
  });
}

it('discards unsaved secrets when the Meta form is closed', async () => {
  const { toggle } = await render();
  const panel = await toggle('whatsapp-business');
  fill(panel);
  await toggle('whatsapp-business');
  expect(panel.querySelector('input')).toBeNull();
  await toggle('whatsapp-business');
  expect(panel.querySelector<HTMLInputElement>('[name="accessToken"]')?.value).toBe('');
});

it('shows configured rather than connected, with the signed Meta URL and no group setup', async () => {
  const { toggle, element } = await render([
    {
      id: 'meta-channel',
      profileId: 'profile',
      type: 'whatsapp-business',
      createdAt: '2026-10-23T12:00:00Z',
      allowAllContacts: false,
    },
  ]);
  const panel = await toggle('whatsapp-business');
  expect(panel.textContent).toContain('/v1/whatsapp-business/meta-channel');
  expect(panel.textContent).not.toContain('/v1/ingress/');
  expect(panel.querySelector('input')).toBeNull();
  expect(panel.querySelector('[role="switch"]')).toBeNull();
  expect(panel.textContent).not.toContain('Add the agent to one');
  expect(panel.textContent).toContain('Replies after expiry are blocked');
  expect(panel.textContent).toContain('Ogg/Opus mono');
  expect(panel.textContent).toContain('16 MB');
  expect(panel.closest('article')?.querySelector('.badge')?.textContent).toBe('Configured');
  expect(element.textContent).toContain('WhatsApp (Baileys)');
});

it('still starts QR pairing only for Baileys', async () => {
  const { toggle, createChannel, connect, element } = await render();
  const panel = await toggle('whatsapp');
  await act(async () => {
    panel
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(createChannel).toHaveBeenCalledWith(profiles[0]?.id, { type: 'whatsapp' });
  expect(connect).toHaveBeenCalledWith(profiles[0]?.id, 'meta-channel');
  expect(element.textContent).toContain('QR pairing opened');
});

it('still sends the BotFather token only for Telegram', async () => {
  const { toggle, createChannel, connect } = await render();
  const panel = await toggle('telegram');
  const input = panel.querySelector<HTMLInputElement>('[name="botToken"]');
  if (!input) throw new Error('Missing Telegram token');
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  await act(async () => {
    setter?.call(input, 'synthetic-bot-token');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    panel
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(createChannel).toHaveBeenCalledWith(profiles[0]?.id, {
    type: 'telegram',
    botToken: 'synthetic-bot-token',
  });
  expect(connect).not.toHaveBeenCalled();
});
