import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Channel, Contact, GatewayApi, ProfileData, Session } from '../../lib/api';
import { profiles } from '../../stories/fixtures';
import { Sessions } from '.';

vi.mock('../../lib/workspace', () => ({
  useWorkspace: () => ({ profiles: [], refresh: vi.fn() }),
}));
vi.mock('./history', () => ({ History: () => <div>History</div> }));
vi.mock('./listeners', () => ({ SessionListeners: () => null }));
vi.mock('./model-picker', () => ({ SessionModel: () => null }));

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
});

const profile = profiles[0];
if (!profile) throw new Error('Missing profile fixture');
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
}: {
  aiEnabled?: boolean;
  busy?: boolean;
  fail?: boolean;
  status?: Contact['status'];
  channel?: string;
  contacts?: Contact[];
} = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const updateContact = vi.fn(async () => {
    if (fail) throw new Error('Owner session required');
  });
  const updateChannel = vi.fn();
  const approveContact = vi.fn();
  const blockContact = vi.fn();
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
      <Sessions
        profile={profile}
        data={
          {
            sessions: [{ ...session, channel }],
            activities: [],
            contacts: contacts.map((item) => ({ ...item, aiEnabled, status })),
            channels: [{ id: 'business', profileId: profile.id, enabled: false } as Channel],
          } as unknown as ProfileData
        }
        api={
          { updateContact, updateChannel, approveContact, blockContact } as unknown as GatewayApi
        }
        mutate={mutate}
        busy={busy}
        initialSession={session.id}
      />,
    ),
  );
  const control = element.querySelector<HTMLButtonElement>('[role="switch"]');
  return { element, control, updateContact, updateChannel, approveContact, blockContact, notices };
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
