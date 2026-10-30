import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Channel, Contact, GatewayApi, Session } from '../../lib/api';
import { memoryNavigation } from '../../platform/navigation';
import { AgentCache } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { goTo } from '../../test/route';
import { Sessions } from '.';

vi.mock('../../lib/workspace', () => ({ useRefresh: () => vi.fn() }));

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
  const markSessionRead = vi.fn(async () => ({}));
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
              markSessionRead,
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
    markSessionRead,
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
    // In the conversation's toolbar below it, not in its header.
    expect(result.control?.closest('.agent-toolbar')).not.toBeNull();
    // A conversation has no header at all: its controls float in the corners.
    expect(result.element.querySelector('.conversation-pane header')).toBeNull();
    expect(result.control?.getAttribute('aria-label')).toBe('AI replies for Customer');
    expect(result.control?.getAttribute('aria-checked')).toBe(String(aiEnabled));
    expect(result.element.textContent).toContain('Channel paused');
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
  expect(busy.control?.getAttribute('aria-disabled')).toBe('true');
  await act(async () => busy.control?.click());
  expect(busy.updateContact).not.toHaveBeenCalled();
  const failed = await render({ fail: true });
  await act(async () => failed.control?.click());
  expect(failed.notices).toEqual(['Owner session required']);
  expect(failed.control?.getAttribute('aria-checked')).toBe('true');
});

it('offers AI replies on every messaging channel, and nowhere else', async () => {
  for (const channel of ['whatsapp', 'telegram']) {
    expect((await render({ channel })).control).not.toBeNull();
  }
  for (const channel of ['api', 'agent', 'learning']) {
    expect((await render({ channel })).control).toBeNull();
  }
  expect((await render({ contacts: [] })).control).toBeNull();
  expect(
    (await render({ contacts: [{ ...contact, profileId: 'another-profile' }] })).control,
  ).toBeNull();
});

it('creates and titles a chat only when the first message is sent, then opens it', async () => {
  const result = await render();
  await act(async () => goTo(`/agents/${profile.id}/sessions`));

  expect(result.createGatewaySession).not.toHaveBeenCalled();
  expect(result.element.querySelector('section[aria-label="New chat"]')).not.toBeNull();
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
  expect(memoryNavigation.current()).toBe(`/agents/${profile.id}/sessions/new-gateway-chat`);
});

it('reads the open chat as it shows', async () => {
  const result = await render({
    sessions: [
      {
        ...session,
        channel: 'gateway',
        title: 'Deploy',
        readAt: '2026-10-30T09:00:00.000Z',
        lastMessage: { role: 'assistant' as const, text: 'Done.', at: '2026-10-30T10:00:00.000Z' },
      },
    ],
  });

  expect(result.markSessionRead).toHaveBeenCalledWith(profile.id, session.id);
});

it('keeps a new chat asked for by the address there while it is written', async () => {
  const { element } = await render();
  await act(async () => goTo(`/agents/${profile.id}/sessions?new`));

  expect(element.querySelector('section[aria-label="New chat"]')).not.toBeNull();
  // A phone shows the draft rather than the list while the request is in the address.
  expect(memoryNavigation.current()).toBe(`/agents/${profile.id}/sessions?new`);
});

it('says so when the conversation in the address is not there', async () => {
  const { element } = await render({ sessions: [] });

  expect(element.textContent).toContain('This conversation is not here');
});
