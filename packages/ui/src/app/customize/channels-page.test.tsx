import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Channel, Contact, GatewayApi } from '../../lib/api';
import { AgentCache } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { ChannelsPage } from './channels-page';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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
const visitor: Contact = {
  id: '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  profileId: profile.id,
  channelId: telegram.id,
  type: 'telegram',
  scope: 'direct',
  actorId: '424242',
  chatId: '424242',
  displayName: 'Mira Holt',
  status: 'pending',
  aiEnabled: true,
  canApprove: false,
  message: 'Hello, is this the front desk?',
  createdAt: '2026-10-02T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
};

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function render(api: Record<string, unknown>, contacts: Contact[] = []) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  actions.api = api as unknown as GatewayApi;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache profile={profile} slices={{ channels: [telegram], contacts, groups: [] }}>
        <ChannelsPage />
      </AgentCache>,
    ),
  );
  return {
    // Inside the open dialog when one is open: the page behind it has buttons of the same name.
    button: (name: string, within: ParentNode = document) =>
      [...within.querySelectorAll('button')].find(
        (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
      ),
    type: (input: HTMLInputElement | null | undefined, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          value,
        );
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      }),
  };
}

const lastDialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1);

it('disconnects a channel only once its name is typed', async () => {
  const revokeChannel = vi.fn(async () => telegram);
  const view = await render({ revokeChannel });

  await act(async () => view.button('Configure Telegram')?.click());
  await act(async () => view.button('Disconnect', lastDialog())?.click());
  const confirm = view.button('Disconnect', lastDialog());
  expect(confirm?.disabled).toBe(true);
  expect(revokeChannel).not.toHaveBeenCalled();

  await view.type(lastDialog()?.querySelector<HTMLInputElement>('form input'), 'Telegram');
  await act(async () => confirm?.click());

  expect(revokeChannel).toHaveBeenCalledWith(profile.id, telegram.id);
});

it('moves the enabled switch at once, and puts it back when the gateway refuses', async () => {
  let refuse!: (reason: Error) => void;
  const updateChannel = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
  );
  const view = await render({ updateChannel });
  await act(async () => view.button('Configure Telegram')?.click());
  const enabled = () =>
    [...(lastDialog()?.querySelectorAll<HTMLElement>('[role="switch"]') ?? [])].find(
      (item) =>
        document.getElementById(item.getAttribute('aria-labelledby') ?? '')?.textContent ===
        'Channel enabled',
    );

  await act(async () => enabled()?.click());
  // Pressed, not yet answered: it already shows what was asked.
  expect(enabled()?.getAttribute('aria-checked')).toBe('false');
  expect(updateChannel).toHaveBeenCalledWith(profile.id, telegram.id, { enabled: false });

  await act(async () => refuse(new Error('Synthetic refusal.')));
  expect(enabled()?.getAttribute('aria-checked')).toBe('true');
});

it('approves a contact waiting on the owner, and declines one only as asked', async () => {
  const approveContact = vi.fn(async () => ({}));
  const blockContact = vi.fn(async () => ({}));
  const view = await render({ approveContact, blockContact }, [visitor]);

  await act(async () => view.button('Configure Telegram')?.click());
  expect(lastDialog()?.textContent).toContain('Hello, is this the front desk?');
  await act(async () => view.button('Approve Mira Holt', lastDialog())?.click());

  expect(approveContact).toHaveBeenCalledWith(profile.id, visitor.id);
  expect(blockContact).not.toHaveBeenCalled();
});
