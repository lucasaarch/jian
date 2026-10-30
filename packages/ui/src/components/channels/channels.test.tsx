import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Channel, Contact, GatewayApi, NewChannel } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { AgentCache, agentClient } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { Channels } from '.';

vi.mock('./pairing', () => ({ Pairing: () => <p>QR pairing opened</p> }));

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function render(
  channels: Channel[] = [],
  fail = false,
  contacts: Contact[] = [],
  busy = false,
) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const createChannel = vi.fn(async (_profileId: string, body: NewChannel) => {
    if (fail) throw new Error('Synthetic save failure');
    return {
      id: 'meta-channel',
      profileId: profile.id,
      type: body.type,
      enabled: true,
      createdAt: '2026-10-23T12:00:00Z',
      allowAllContacts: false,
      webhookToken: 'synthetic-unused-ingress-token',
    };
  });
  const updateChannel = vi.fn(async () => {
    if (fail) throw new Error('Synthetic save failure');
  });
  const connect = vi.fn(async () => {});
  const updateContact = vi.fn(async () => {
    if (fail) throw new Error('Synthetic save failure');
  });
  const approveContact = vi.fn(async () => {});
  const blockContact = vi.fn(async () => {});
  const revokeChannel = vi.fn(async () => {});
  const api = {
    createChannel,
    updateChannel,
    updateContact,
    approveContact,
    blockContact,
    revokeChannel,
    connect,
  } as unknown as GatewayApi;
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
  const client = agentClient({ profile, slices: { channels, contacts, groups: [] } });
  await act(async () => {
    root.render(
      <AgentCache client={client} profile={profile}>
        <Channels api={api} mutate={mutate} busy={busy} />
      </AgentCache>,
    );
  });
  // What the panel's reload after an action brings: the same screen, on the gateway's answer.
  const refresh = async (next: Channel[]) =>
    act(async () => {
      client.setQueryData(keys.channels(profile.id), next);
      // The cache tells its readers on the next tick, not within this one.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const toggle = async (type: string) => {
    await act(async () =>
      element.querySelector<HTMLButtonElement>(`[aria-controls="channel-${type}"]`)?.click(),
    );
    const panel = element.querySelector<HTMLElement>(`#channel-${type}`);
    if (!panel) throw new Error('Missing channel panel');
    return panel;
  };
  return {
    element,
    createChannel,
    updateChannel,
    updateContact,
    approveContact,
    blockContact,
    revokeChannel,
    connect,
    mutate,
    toggle,
    refresh,
  };
}

const business: Channel = {
  id: 'business',
  profileId: 'profile',
  type: 'whatsapp-business',
  createdAt: '2026-10-23T12:00:00Z',
  whatsappBusinessStatus: 'configured',
  enabled: true,
  allowAllContacts: false,
};
const customer: Contact = {
  id: 'customer',
  profileId: 'profile',
  channelId: business.id,
  type: 'whatsapp-business',
  actorId: '5511999999999',
  chatId: '5511999999999',
  displayName: 'Customer',
  status: 'approved',
  aiEnabled: true,
  canApprove: false,
  scope: 'direct',
  createdAt: '2026-10-23T12:00:00Z',
  updatedAt: '2026-10-23T12:00:00Z',
};

for (const enabled of [undefined, true, false]) {
  it(`saves only enabled when the channel enabled switch is ${enabled}`, async () => {
    const { enabled: _enabled, ...legacyChannel } = business;
    // Deliberately omit the required field to exercise pre-automation API payloads.
    const channel = enabled === undefined ? (legacyChannel as Channel) : { ...business, enabled };
    const { toggle, updateChannel, revokeChannel, connect } = await render([channel]);
    const panel = await toggle('whatsapp-business');
    const control = panel.querySelector<HTMLButtonElement>('[aria-label="Channel enabled"]');
    expect(control?.getAttribute('aria-checked')).toBe(String(enabled ?? true));
    await act(async () => control?.click());
    expect(updateChannel).toHaveBeenCalledExactlyOnceWith(profile.id, business.id, {
      enabled: !(enabled ?? true),
    });
    expect(revokeChannel).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(panel.textContent).toContain('not answered later');
    expect(panel.textContent).toContain('Jian does not enable app/API coexistence');
    if (enabled === false) expect(panel.closest('article')?.textContent).toContain('Disabled');
  });
}

for (const type of ['whatsapp', 'whatsapp-business', 'telegram', 'api'] as const) {
  it(`allows everyone on ${type} with a separate permissions patch`, async () => {
    const { toggle, updateChannel } = await render([{ ...business, type }]);
    const panel = await toggle(type);
    // An API server admits senders of the owner's systems, not contacts.
    const label = type === 'api' ? 'Allow all senders' : 'Allow all contacts';
    const control = panel.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    expect(control?.getAttribute('aria-checked')).toBe('false');
    await act(async () => control?.click());
    expect(updateChannel).toHaveBeenCalledExactlyOnceWith(profile.id, business.id, {
      allowAllContacts: true,
    });
  });
}

it('keeps controls unchanged when saving fails and disables them while busy', async () => {
  const failed = await render([business], true, [customer]);
  const panel = await failed.toggle('whatsapp-business');
  for (const control of panel.querySelectorAll<HTMLButtonElement>('[role="switch"]')) {
    const checked = control.getAttribute('aria-checked');
    await act(async () => control.click());
    expect(control.getAttribute('aria-checked')).toBe(checked);
  }
  const busy = await render([business], false, [customer], true);
  for (const control of busy.element.querySelectorAll<HTMLButtonElement>('[role="switch"]')) {
    expect(control.disabled).toBe(true);
    await act(async () => control.click());
  }
  expect(busy.updateContact).not.toHaveBeenCalled();
  expect(busy.updateChannel).not.toHaveBeenCalled();
});

it('keeps AI controls out of Channels for all contact statuses', async () => {
  const pending = await render([business], false, [
    { ...customer, status: 'pending', aiEnabled: false },
  ]);
  expect(pending.element.querySelector('[aria-label="AI replies for Customer"]')).toBeNull();
  expect(pending.element.textContent).toContain('Approving does not turn the channel back on');
  const blocked = await render([business], false, [{ ...customer, status: 'blocked' }]);
  expect(blocked.element.querySelector('[aria-label="AI replies for Customer"]')).toBeNull();
  const baileys = await render([{ ...business, type: 'whatsapp' }], false, [
    { ...customer, type: 'whatsapp' },
  ]);
  expect(baileys.element.querySelector('[aria-label="AI replies for Customer"]')).toBeNull();
});

it('lets the owner mark who may approve actions, and patches only that', async () => {
  const { toggle, updateContact, updateChannel } = await render([business], false, [customer]);
  const panel = await toggle('whatsapp-business');
  const control = panel.querySelector<HTMLButtonElement>(
    '[aria-label="Customer can approve actions"]',
  );
  expect(control?.getAttribute('aria-checked')).toBe('false');
  expect(panel.textContent).toContain('Their yes in the chat runs what the agent asked to do');
  await act(async () => control?.click());
  expect(updateContact).toHaveBeenCalledExactlyOnceWith(profile.id, customer.id, {
    canApprove: true,
  });
  expect(updateChannel).not.toHaveBeenCalled();
});

it('saves a channel’s own approval wording and the replies it takes', async () => {
  const { toggle, updateChannel } = await render([{ ...business, type: 'telegram' }]);
  const panel = await toggle('telegram');
  const open = [...panel.querySelectorAll('button')].find((item) =>
    item.textContent?.includes('Messages'),
  );
  await act(async () => open?.click());
  const field = (label: string) => {
    const tag = [...panel.querySelectorAll('label')].find((item) => item.textContent === label);
    return tag ? panel.querySelector<HTMLInputElement>(`[id="${tag.htmlFor}"]`) : null;
  };
  const type = async (
    input: HTMLInputElement | HTMLTextAreaElement | null | undefined,
    value: string,
  ) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    await act(async () => {
      setter?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  await type(field('Replies that approve'), 'go, do it');
  await act(async () =>
    panel
      .querySelector('.channel-messages-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(updateChannel).toHaveBeenCalledExactlyOnceWith(
    profile.id,
    business.id,
    expect.objectContaining({
      messages: expect.objectContaining({ approveWords: ['go', 'do it'] }),
    }),
  );
});

const credentials = {
  accessToken: 'synthetic-access-token',
  appSecret: 'synthetic-app-secret',
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
    expect(panel.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(panel.querySelectorAll('input')).toHaveLength(1);
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const verifyToken = panel.querySelector<HTMLInputElement>('[name="verifyToken"]');
    if (!verifyToken) throw new Error('Missing verify token field');
    verifyToken.value = 'synthetic-verify-secret';
    await act(async () => {
      panel
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(createChannel).toHaveBeenCalledWith(profile.id, {
      type: 'whatsapp-business',
      whatsappBusiness: { verifyToken: 'synthetic-verify-secret' },
    });
    expect(connect).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    expect(panel.querySelector('[name="accessToken"]')).toBeNull();
    expect(panel.querySelector('[name="appSecret"]')).toBeNull();
    expect(panel.querySelector<HTMLInputElement>('[name="verifyToken"]')?.value).toBe('');
    expect(element.textContent).not.toContain('synthetic-unused-ingress-token');
    expect(document.body.textContent).not.toContain('Webhook configuration');
    expect(mutate.mock.calls[0]?.[1]).toContain('Setup pending');
  });
}

it('discards unsaved secrets when the Meta form is closed', async () => {
  const { toggle } = await render();
  const panel = await toggle('whatsapp-business');
  const input = panel.querySelector<HTMLInputElement>('[name="verifyToken"]');
  if (!input) throw new Error('Missing verify token field');
  input.value = 'synthetic-verify-secret';
  await toggle('whatsapp-business');
  expect(panel.querySelector('input')).toBeNull();
  await toggle('whatsapp-business');
  expect(panel.querySelector<HTMLInputElement>('[name="verifyToken"]')?.value).toBe('');
});

it('shows configured rather than connected, with the signed Meta URL and no group setup', async () => {
  const { toggle, element } = await render([
    {
      id: 'meta-channel',
      profileId: 'profile',
      type: 'whatsapp-business',
      enabled: true,
      createdAt: '2026-10-23T12:00:00Z',
      allowAllContacts: false,
    },
  ]);
  const panel = await toggle('whatsapp-business');
  expect(panel.querySelector<HTMLTextAreaElement>('textarea')?.value).toContain(
    '/v1/whatsapp-business/meta-channel',
  );
  expect(panel.textContent).not.toContain('/v1/ingress/');
  expect(panel.querySelector('input')).toBeNull();
  expect(panel.querySelector('[aria-label="Allow all contacts"]')).not.toBeNull();
  expect(panel.querySelector('[aria-label="Channel enabled"]')?.getAttribute('aria-checked')).toBe(
    'true',
  );
  expect(panel.textContent).not.toContain('Add the agent to one');
  expect(panel.textContent).toContain('Replies after expiry are blocked');
  expect(panel.textContent).toContain('Ogg/Opus mono');
  expect(panel.textContent).toContain('16 MB');
  const badge = panel.closest('article')?.querySelector('.badge');
  expect(badge?.textContent).toBe('Configured');
  expect(badge?.classList.contains('good')).toBe(true);
  expect(element.textContent).toContain('WhatsApp (Baileys)');
});

const pendingChannel: Channel = {
  id: 'generated-meta-channel',
  profileId: 'profile',
  type: 'whatsapp-business',
  enabled: true,
  createdAt: '2026-10-23T12:00:00Z',
  allowAllContacts: false,
  whatsappBusinessStatus: 'pending',
};

for (const fail of [false, true]) {
  it(`completes pending setup with four fields on ${fail ? 'failure' : 'success'}, preserving the callback and verify token`, async () => {
    const { toggle, createChannel, updateChannel, connect } = await render([pendingChannel], fail);
    const panel = await toggle('whatsapp-business');
    expect(panel.closest('article')?.querySelector('.badge')?.textContent).toBe('Setup pending');
    expect(panel.textContent).toContain('Messaging is unavailable');
    expect(panel.querySelectorAll('input')).toHaveLength(4);
    expect(panel.querySelector('[name="verifyToken"]')).toBeNull();
    expect(panel.querySelectorAll('input[type="password"]')).toHaveLength(2);
    const callback = panel.querySelector<HTMLTextAreaElement>('textarea')?.value;
    expect(callback).toBe(`${window.location.origin}/v1/whatsapp-business/generated-meta-channel`);
    expect(callback).not.toContain('<channelId>');
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    fill(panel);
    await act(async () => {
      panel
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(updateChannel).toHaveBeenCalledWith(profile.id, pendingChannel.id, {
      whatsappBusiness: credentials,
    });
    expect(createChannel).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    for (const input of panel.querySelectorAll('input')) expect(input.value).toBe('');
    expect(panel.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(callback);
  });
}

it('shows the returned callback immediately after creation, then configured after completion refresh', async () => {
  const { toggle, refresh, createChannel, updateChannel } = await render();
  const panel = await toggle('whatsapp-business');
  const input = panel.querySelector<HTMLInputElement>('[name="verifyToken"]');
  if (!input) throw new Error('Missing verify token');
  input.value = 'synthetic-verify-secret';
  await act(async () => {
    panel
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(createChannel).toHaveBeenCalledOnce();
  await refresh([pendingChannel]);
  expect(panel.hidden).toBe(false);
  const callback = panel.querySelector<HTMLTextAreaElement>('textarea')?.value;
  expect(callback).toBe(`${window.location.origin}/v1/whatsapp-business/${pendingChannel.id}`);
  fill(panel);
  await act(async () => {
    panel
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(updateChannel).toHaveBeenCalledWith(profile.id, pendingChannel.id, {
    whatsappBusiness: credentials,
  });
  await refresh([{ ...pendingChannel, whatsappBusinessStatus: 'configured' }]);
  expect(panel.closest('article')?.querySelector('.badge')?.textContent).toBe('Configured');
  expect(panel.querySelector('form')).toBeNull();
  expect(panel.querySelector('input')).toBeNull();
  expect(panel.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(callback);
});

it('unmounts pending credential fields on close and opens empty on return', async () => {
  const { toggle } = await render([pendingChannel]);
  const panel = await toggle('whatsapp-business');
  fill(panel);
  await toggle('whatsapp-business');
  expect(panel.querySelector('input')).toBeNull();
  await toggle('whatsapp-business');
  for (const input of panel.querySelectorAll('input')) expect(input.value).toBe('');
});

it('copies the generated callback and offers manual copying if clipboard access is refused', async () => {
  const { toggle } = await render([pendingChannel]);
  const panel = await toggle('whatsapp-business');
  const writeText = vi
    .spyOn(navigator.clipboard, 'writeText')
    .mockRejectedValueOnce(new Error('Denied'));
  const copy = Array.from(panel.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Copy callback URL'),
  );
  await act(async () => copy?.click());
  expect(panel.querySelector('[role="alert"]')?.textContent).toContain('copy it by hand');
  writeText.mockResolvedValueOnce();
  await act(async () => copy?.click());
  expect(writeText).toHaveBeenLastCalledWith(
    `${window.location.origin}/v1/whatsapp-business/generated-meta-channel`,
  );
  expect(copy?.textContent).toContain('Copied');
  expect(panel.querySelector('[role="alert"]')).toBeNull();
});

it('still starts QR pairing only for Baileys', async () => {
  const { toggle, createChannel, connect, element } = await render();
  const panel = await toggle('whatsapp');
  await act(async () => {
    panel
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(createChannel).toHaveBeenCalledWith(profile.id, { type: 'whatsapp' });
  expect(connect).toHaveBeenCalledWith(profile.id, 'meta-channel');
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
  expect(createChannel).toHaveBeenCalledWith(profile.id, {
    type: 'telegram',
    botToken: 'synthetic-bot-token',
  });
  expect(connect).not.toHaveBeenCalled();
});

it('shows a channel by its badge alone, and only the sections it has records for', async () => {
  const { element, toggle } = await render([{ ...business, type: 'whatsapp' }], false, []);
  // No counts or connection date beside the name, open or closed.
  const summary = () => element.querySelector('article .grow')?.textContent;
  expect(summary()).not.toMatch(/\d+ contacts?|\d+ groups?|Connected on/);
  const panel = await toggle('whatsapp');
  expect(summary()).not.toMatch(/\d+ contacts?|\d+ groups?|Connected on/);
  expect([...panel.querySelectorAll('h3')].map((heading) => heading.textContent)).toEqual([]);
  expect(panel.textContent).not.toContain('reads everything');
  const switches = [...panel.querySelectorAll('[role="switch"]')].map((item) =>
    item.getAttribute('aria-label'),
  );
  expect(switches).toEqual(['Channel enabled', 'Allow all contacts']);
  const disconnect = [...panel.querySelectorAll('button')].find(
    (button) => button.textContent === 'Disconnect',
  );
  expect(disconnect?.classList.contains('danger')).toBe(true);
});
