import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi, ModelDefaults, Session } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { AgentCache, agentClient } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { SessionModel } from './model-picker';

const picked = { providerId: 'provider', modelId: 'atlas-large', reasoningEffort: 'high' };

vi.mock('./model-menu', () => ({
  ModelMenu: ({ onChange }: { onChange: (model: unknown) => void }) => (
    <button type="button" onClick={() => onChange(picked)}>
      Pick
    </button>
  ),
  EffortMenu: () => null,
}));

const defaults = {
  conversation: { providerId: 'provider', modelId: 'atlas-small' },
  channel: { providerId: 'provider', modelId: 'atlas-channel' },
  updatedAt: '2026-10-31T10:00:00Z',
} as unknown as ModelDefaults;
const session = {
  id: 's-1',
  channel: 'gateway',
  model: { providerId: 'provider', modelId: 'atlas-small' },
} as unknown as Session;

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function pick({
  remembers = true,
  open,
  setSessionModel = vi.fn(async () => open),
}: {
  remembers?: boolean;
  open?: Session;
  setSessionModel?: ReturnType<typeof vi.fn>;
}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const setModelDefaults = vi.fn(async () => defaults);
  const api = { setModelDefaults, setSessionModel } as unknown as GatewayApi;
  const client = agentClient({
    profile,
    slices: { providers: [], providerModels: {}, modelDefaults: defaults },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache client={client} profile={profile}>
        <SessionModel
          api={api}
          profileId={profile.id}
          channel={false}
          saved={() => {}}
          remembers={remembers}
          onDraftChange={() => {}}
          {...(open ? { session: open } : {})}
        />
      </AgentCache>,
    ),
  );
  await act(async () => host.querySelector('button')?.click());
  const conversation = client.getQueryData<ModelDefaults>(keys.modelDefaults)?.conversation;
  return { setModelDefaults, setSessionModel, conversation };
}

it('makes a pick in a new chat the preference, before anything is sent', async () => {
  const { setModelDefaults, conversation } = await pick({});

  // Only what a chat chooses moves; a channel's own model is not touched.
  expect(setModelDefaults).toHaveBeenCalledWith({
    conversation: picked,
    channel: defaults.channel,
  });
  expect(conversation).toEqual(picked);
});

it('makes a pick in an existing conversation the preference too', async () => {
  const { setModelDefaults, setSessionModel } = await pick({ open: session });

  expect(setSessionModel).toHaveBeenCalledWith(profile.id, session.id, picked);
  expect(setModelDefaults).toHaveBeenCalledWith(expect.objectContaining({ conversation: picked }));
});

it('leaves the preference alone when the conversation could not take the model', async () => {
  const { setModelDefaults, conversation } = await pick({
    open: session,
    setSessionModel: vi.fn(async () => {
      throw new Error('Offline');
    }),
  });

  expect(setModelDefaults).not.toHaveBeenCalled();
  expect(conversation).toEqual(defaults.conversation);
});

it('leaves the preference alone where a pick is not a composer’s, such as a schedule', async () => {
  const { setModelDefaults } = await pick({ remembers: false });

  expect(setModelDefaults).not.toHaveBeenCalled();
});
