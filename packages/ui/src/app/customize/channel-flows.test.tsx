import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Channel, Contact, GatewayApi, NewChannel } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { AgentCache, agentClient } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { ChannelsPage } from './channels-page';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('./channel-pairing', () => ({
  ChannelPairing: ({ open }: { open: boolean }) => (open ? <p>QR pairing opened</p> : null),
}));

const actions = vi.hoisted(() => ({ api: {} as GatewayApi }));
vi.mock('../../lib/workspace', () => ({
  useActions: () => ({
    api: actions.api,
    // As the panel's own: false when the action failed.
    mutate: (action: () => Promise<unknown>) =>
      action().then(
        () => true,
        () => false,
      ),
    busy: false,
  }),
}));

const telegram: Channel = {
  id: '0d7c2a91-5b3e-4f6a-9c8d-1e2f3a4b5c6d',
  profileId: profile.id,
  type: 'telegram',
  enabled: true,
  allowAllContacts: false,
  createdAt: '2026-10-01T00:00:00Z',
};
const pendingMeta: Channel = {
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  profileId: profile.id,
  type: 'whatsapp-business',
  enabled: true,
  allowAllContacts: false,
  whatsappBusinessStatus: 'pending',
  createdAt: '2026-10-01T00:00:00Z',
};
const guest: Contact = {
  id: '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  profileId: profile.id,
  channelId: telegram.id,
  type: 'telegram',
  scope: 'direct',
  actorId: '424242',
  chatId: '424242',
  displayName: 'Mira Holt',
  status: 'approved',
  aiEnabled: true,
  canApprove: false,
  createdAt: '2026-10-02T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
};
const credentials = {
  accessToken: 'synthetic-access-token',
  appSecret: 'synthetic-app-secret',
  phoneNumberId: '123456',
  businessAccountId: '987654',
};

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function render(channels: Channel[] = [], contacts: Contact[] = [], fail = false) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const refuse = async () => {
    if (fail) throw new Error('Synthetic save failure');
  };
  const api = {
    createChannel: vi.fn(async (_profileId: string, body: NewChannel) => {
      await refuse();
      return { ...telegram, id: 'created-channel', type: body.type, webhookToken: 'unused' };
    }),
    updateChannel: vi.fn(refuse),
    updateContact: vi.fn(refuse),
    connect: vi.fn(async () => {}),
    connection: vi.fn(async () => ({ status: 'pairing' })),
  };
  actions.api = api as unknown as GatewayApi;
  const client = agentClient({ profile, slices: { channels, contacts, groups: [] } });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache client={client} profile={profile}>
        <ChannelsPage />
      </AgentCache>,
    ),
  );
  const refresh = (next: Channel[]) =>
    act(async () => {
      client.setQueryData(keys.channels(profile.id), next);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return { api, refresh };
}

const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1);
const press = async (name: string, within: ParentNode = document) => {
  const target = [...within.querySelectorAll<HTMLElement>('button, [role="switch"]')].find(
    (item) =>
      item.getAttribute('aria-label') === name ||
      item.textContent?.trim() === name ||
      // A switch on a settings row is named by the row's title.
      document.getElementById(item.getAttribute('aria-labelledby') ?? '')?.textContent === name,
  );
  if (!target) throw new Error(`No ${name} button`);
  await act(async () => target.click());
};
const field = (label: string) => {
  const tag = [...document.querySelectorAll('label')].find((item) => item.textContent === label);
  return tag ? (document.getElementById(tag.htmlFor) as HTMLInputElement | null) : null;
};
const type = (input: HTMLInputElement | HTMLTextAreaElement | null, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, 'value')?.set?.call(
      input,
      value,
    );
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
const submit = (form: HTMLFormElement | null | undefined) =>
  act(async () => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

async function add(kind: string) {
  await press('Add');
  await press(kind, dialog());
}

it('connects Telegram with its bot token alone, and pairs nothing', async () => {
  const { api } = await render();
  await add('Telegram');

  await type(field('Bot token'), 'synthetic-bot-token');
  await press('Connect', dialog());

  expect(api.createChannel).toHaveBeenCalledWith(profile.id, {
    type: 'telegram',
    botToken: 'synthetic-bot-token',
  });
  expect(api.connect).not.toHaveBeenCalled();
});

it('starts pairing a WhatsApp device as soon as its channel exists', async () => {
  const { api } = await render();
  await add('WhatsApp');

  await press('Connect', dialog());

  expect(api.createChannel).toHaveBeenCalledWith(profile.id, { type: 'whatsapp' });
  expect(api.connect).toHaveBeenCalledWith(profile.id, 'created-channel');
  expect(document.body.textContent).toContain('QR pairing opened');
});

it('creates Meta’s callback with the verify token alone, and keeps no secret anywhere', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const { api } = await render();
  await add('WhatsApp Business');

  const token = field('Verify token');
  if (token) token.value = 'synthetic-verify-secret';
  await submit(token?.form);

  expect(api.createChannel).toHaveBeenCalledWith(profile.id, {
    type: 'whatsapp-business',
    whatsappBusiness: { verifyToken: 'synthetic-verify-secret' },
  });
  expect(api.connect).not.toHaveBeenCalled();
  expect(storage).not.toHaveBeenCalled();
});

for (const fail of [false, true]) {
  it(`completes Meta’s setup with its four credentials alone, cleared ${fail ? 'after a refusal' : 'once saved'}`, async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const { api } = await render([pendingMeta], [], fail);
    await press('Configure WhatsApp Business (Meta)');

    // Where Meta must post, with the channel's own id.
    expect(dialog()?.textContent).toContain(`/v1/whatsapp-business/${pendingMeta.id}`);
    expect(dialog()?.textContent).toContain('Messaging is unavailable');
    for (const [name, value] of Object.entries(credentials)) {
      const input = dialog()?.querySelector<HTMLInputElement>(`[name="${name}"]`);
      if (!input) throw new Error(`No ${name} field`);
      input.value = value;
    }
    await submit(dialog()?.querySelector('form'));

    expect(api.updateChannel).toHaveBeenCalledWith(profile.id, pendingMeta.id, {
      whatsappBusiness: credentials,
    });
    expect(api.createChannel).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    for (const name of Object.keys(credentials)) {
      expect(dialog()?.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value).toBe('');
    }
  });
}

it('patches only what each of a channel’s switches changes', async () => {
  const { api } = await render([telegram]);
  await press('Configure Telegram');

  await press('Allow all contacts', dialog());
  await press('Channel enabled', dialog());

  expect(api.updateChannel).toHaveBeenNthCalledWith(1, profile.id, telegram.id, {
    allowAllContacts: true,
  });
  expect(api.updateChannel).toHaveBeenNthCalledWith(2, profile.id, telegram.id, {
    enabled: false,
  });
});

it('lets the owner mark who may approve actions, patching only that contact', async () => {
  const { api } = await render([telegram], [guest]);
  await press('Configure Telegram');

  await press('Mira Holt can approve actions', dialog());

  expect(api.updateContact).toHaveBeenCalledExactlyOnceWith(profile.id, guest.id, {
    canApprove: true,
  });
  expect(api.updateChannel).not.toHaveBeenCalled();
});

it('saves a channel’s own approval wording and the replies it takes', async () => {
  const { api } = await render([telegram]);
  await press('Configure Telegram');
  await press('Edit messages', dialog());

  await type(field('Replies that approve'), 'go, do it');
  await press('Save', dialog());

  expect(api.updateChannel).toHaveBeenCalledExactlyOnceWith(
    profile.id,
    telegram.id,
    expect.objectContaining({
      messages: expect.objectContaining({ approveWords: ['go', 'do it'] }),
    }),
  );
});
