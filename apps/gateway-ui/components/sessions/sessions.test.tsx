import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentCache } from '@/test/agent';
import { profile } from '@/test/fixtures';
import type { Channel, Contact, GatewayApi, Session } from '../../lib/api';
import { Sessions } from '.';

const { deleteConversation } = vi.hoisted(() => ({
  deleteConversation: vi.fn(async () => true),
}));

vi.mock('../../lib/workspace', () => ({
  useRefresh: () => vi.fn(),
  useDeleteConversation: () => deleteConversation,
}));

vi.mock('./history', () => ({ History: () => <div>History</div> }));
vi.mock('./listeners', () => ({ SessionListeners: () => null }));
vi.mock('./model-picker', () => ({ SessionModel: () => null }));

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
});

const session = {
  id: 'business-session',
  profileId: profile.id,
  channel: 'whatsapp-business',
  createdAt: '2026-10-23T12:00:00Z',
} as Session;
const contact = {
  id: 'customer',
  sessionId: session.id,
  profileId: profile.id,
  channelId: 'business',
  type: 'whatsapp-business',
  displayName: 'Customer',
  actorId: '5511999999999',
  status: 'approved',
  aiEnabled: true,
  scope: 'direct',
} as Contact;

async function render({
  aiEnabled = true,
  busy = false,
  fail = false,
  status = 'approved',
  channel = 'whatsapp-business',
  contacts = [contact],
  sessions = [{ ...session, channel }],
}: {
  aiEnabled?: boolean;
  busy?: boolean;
  fail?: boolean;
  status?: Contact['status'];
  channel?: string;
  contacts?: Contact[];
  sessions?: Session[];
} = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const updateContact = vi.fn(async () => {
    if (fail) throw new Error('Owner session required');
  });
  const updateChannel = vi.fn();
  const approveContact = vi.fn();
  const blockContact = vi.fn();
  const deleteSession = vi.fn();
  const createGatewaySession = vi.fn(async () => ({
    ...session,
    id: 'new-gateway-chat',
    channel: 'gateway',
  }));
  const renameSession = vi.fn(async () => ({}));
  const sendMessage = vi.fn(async () => ({}));
  const notices: string[] = [];
  const mutate = vi.fn(async (action: () => Promise<unknown>) => {
    try {
      await action();
      return true;
    } catch (error) {
      notices.push((error as Error).message);
      return false;
    }
  });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () =>
    root.render(
      // The conversation is the one in the URL.
      <AgentCache
        profile={profile}
        params={{ sessionId: 'business-session' }}
        slices={{
          providers: [],
          sessions,
          projects: [],
          activities: [],
          contacts: contacts.map((item) => ({ ...item, aiEnabled, status })),
          channels: [
            {
              id: 'business',
              profileId: profile.id,
              type: 'whatsapp-business',
              whatsappBusinessStatus: 'configured',
              enabled: false,
            } as Channel,
          ],
        }}
      >
        <Sessions
          api={
            {
              updateContact,
              updateChannel,
              approveContact,
              blockContact,
              deleteSession,
              createGatewaySession,
              renameSession,
              send: sendMessage,
              // The chat offers the remote machines it can run on; none are connected here.
              remoteMachines: vi.fn(async () => []),
            } as unknown as GatewayApi
          }
          mutate={mutate}
          busy={busy}
        />
      </AgentCache>,
    ),
  );
  const control = element.querySelector<HTMLButtonElement>('[role="switch"]');
  return {
    element,
    control,
    updateContact,
    updateChannel,
    approveContact,
    blockContact,
    deleteSession,
    createGatewaySession,
    renameSession,
    sendMessage,
    mutate,
    notices,
  };
}

for (const aiEnabled of [true, false]) {
  it(`changes only the active contact AI flag from ${aiEnabled}`, async () => {
    const result = await render({
      aiEnabled,
      contacts: [
        { ...contact, id: 'wrong-profile', profileId: 'another-profile' },
        { ...contact, id: 'wrong-session', sessionId: 'another-session' },
        contact,
      ],
    });
    expect(result.control?.closest('.conversation-pane > header')).not.toBeNull();
    expect(result.control?.getAttribute('aria-label')).toBe('AI replies for Customer');
    expect(result.control?.getAttribute('aria-checked')).toBe(String(aiEnabled));
    expect(result.element.textContent).toContain('Channel automation paused');
    expect(result.element.textContent).toContain('never replayed');
    await act(async () => result.control?.click());
    expect(result.updateContact).toHaveBeenCalledExactlyOnceWith(profile.id, contact.id, {
      aiEnabled: !aiEnabled,
    });
    expect(result.updateChannel).not.toHaveBeenCalled();
    expect(result.approveContact).not.toHaveBeenCalled();
    expect(result.blockContact).not.toHaveBeenCalled();
  });
}

for (const status of ['pending', 'blocked'] as const) {
  it(`does not approve a ${status} contact when enabling AI`, async () => {
    const result = await render({ status, aiEnabled: false });
    expect(result.element.textContent).toContain(`Contact ${status}`);
    await act(async () => result.control?.click());
    expect(result.updateContact).toHaveBeenCalledOnce();
    expect(result.approveContact).not.toHaveBeenCalled();
  });
}

it('disables while busy and leaves the flag unchanged on authorization/save errors', async () => {
  const busy = await render({ busy: true });
  expect(busy.control?.disabled).toBe(true);
  await act(async () => busy.control?.click());
  expect(busy.updateContact).not.toHaveBeenCalled();
  const failed = await render({ fail: true });
  await act(async () => failed.control?.click());
  expect(failed.notices).toEqual(['Owner session required']);
  expect(failed.control?.getAttribute('aria-checked')).toBe('true');
});

it('does not offer AI controls for other channels or unmatched contacts', async () => {
  for (const channel of ['whatsapp', 'telegram', 'api', 'agent', 'learning']) {
    expect((await render({ channel })).control).toBeNull();
  }
  expect((await render({ contacts: [] })).control).toBeNull();
  expect(
    (await render({ contacts: [{ ...contact, profileId: 'another-profile' }] })).control,
  ).toBeNull();
});

it('opens the channel selector and filters the conversation list', async () => {
  const gateway = {
    id: 'gateway-chat',
    profileId: profile.id,
    title: null,
    channel: 'gateway',
    createdAt: '2026-10-23T12:00:00Z',
  } as Session;
  const result = await render({ sessions: [gateway, session] });

  const trigger = result.element.querySelector<HTMLButtonElement>('[aria-label="Channel"]');
  await act(async () => trigger?.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === 'WhatsApp Business (Meta)',
  );
  expect(option).toBeDefined();
  await act(async () => option?.click());

  expect(trigger?.textContent).toContain('WhatsApp Business (Meta)');
  expect(
    [...result.element.querySelectorAll('.conversation-item strong')].map(
      (item) => item.textContent,
    ),
  ).toEqual(['Customer']);
});

it('creates and titles a chat only when the first message is sent', async () => {
  const result = await render();
  const create = result.element.querySelector<HTMLButtonElement>('[aria-label="New chat"]');
  await act(async () => create?.click());

  expect(result.createGatewaySession).not.toHaveBeenCalled();
  expect(result.element.querySelector('.draft-empty')).not.toBeNull();
  expect(result.element.querySelector('textarea')).not.toBeNull();
  const input = result.element.querySelector<HTMLTextAreaElement>('textarea');
  if (!input) throw new Error('Draft composer missing');
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    valueSetter?.call(input, '  Fix the first bug  ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const send = result.element.querySelector<HTMLButtonElement>('[aria-label="Send"]');
  await act(async () => send?.click());

  // No project and no remote machine were picked for the draft: it runs on the gateway.
  expect(result.createGatewaySession).toHaveBeenCalledWith(profile.id, null, null);
  expect(result.renameSession).toHaveBeenCalledWith(
    profile.id,
    'new-gateway-chat',
    'Fix the first bug',
  );
  expect(result.sendMessage).toHaveBeenCalledWith(
    profile.id,
    'new-gateway-chat',
    'Fix the first bug',
    [],
  );
  expect(result.mutate).not.toHaveBeenCalled();
});

it('deletes from the row context menu and omits conversation avatars', async () => {
  deleteConversation.mockClear();
  const result = await render();
  const row = result.element.querySelector('.conversation-item');
  if (!row) throw new Error('Conversation row missing');

  await act(async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 100 }));
  });
  expect(result.element.querySelector('.conversation-avatar')).toBeNull();
  const remove = result.element.querySelector<HTMLButtonElement>('[role="menuitem"]');
  expect(remove?.textContent).toBe('Delete conversation');
  result.element
    .querySelector('[role="menu"]')
    ?.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  expect(result.element.querySelector('[role="menuitem"]')).not.toBeNull();
  await act(async () => remove?.click());

  expect(deleteConversation).toHaveBeenCalledWith(session.id);
  expect(result.notices).toEqual([]);
});

it('renames a chat from its context menu', async () => {
  const result = await render({
    sessions: [{ ...session, id: 'gateway-chat', channel: 'gateway', title: 'Old title' }],
  });
  const row = result.element.querySelector('.conversation-item');
  if (!row) throw new Error('Conversation row missing');
  await act(async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 100 }));
  });
  const rename = [...result.element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent === 'Rename conversation',
  );
  await act(async () => rename?.click());

  const input = result.element.querySelector<HTMLInputElement>('#rename-conversation-form input');
  if (!input) throw new Error('Rename field missing');
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    valueSetter?.call(input, 'New title');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const form = result.element.querySelector<HTMLFormElement>('#rename-conversation-form');
  await act(async () =>
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );

  expect(result.renameSession).toHaveBeenCalledWith(profile.id, 'gateway-chat', 'New title');
  expect(result.mutate).toHaveBeenCalled();
});
