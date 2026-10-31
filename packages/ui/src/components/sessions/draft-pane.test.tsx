import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GatewayApi, Profile } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { useCrew } from '../../lib/stores/crew';
import { useDrafts } from '../../lib/stores/drafts';
import { DraftPane } from './draft-pane';

// What the composer's controls read from the gateway has no part in sending.
vi.mock('./context-ring', () => ({ ContextRing: () => null }));
// The menus are stood in for by what they hand back: the owner's choice of each.
const chosen = vi.hoisted(() => ({
  model: undefined as unknown,
  protection: undefined as string | undefined,
  apply: [] as Array<() => void>,
}));
const applyChoices = () => {
  for (const apply of chosen.apply.splice(0)) apply();
};
vi.mock('./model-picker', () => ({
  SessionModel: ({ onDraftChange }: { onDraftChange: (model: unknown) => void }) => {
    chosen.apply.push(() => onDraftChange(chosen.model));
    return null;
  },
}));
vi.mock('./protection-menu', () => ({
  SessionProtection: ({
    draft,
    onDraftChange,
  }: {
    draft: string;
    onDraftChange: (protection: string) => void;
  }) => {
    if (chosen.protection) chosen.apply.push(() => onDraftChange(chosen.protection as string));
    return <span data-protection={draft} />;
  },
}));

const profile = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Atlas',
  summary: 'Helps',
  avatar: null,
} as unknown as Profile;
const session = { id: '00000000-0000-4000-8000-000000000002', protection: 'ask' };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

let root: Root;
let element: HTMLDivElement;
let client: QueryClient;
const opened = vi.fn();
const sent = vi.fn();

const render = async (api: Partial<GatewayApi>) => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DraftPane
          api={
            {
              settings: async () => ({ timeZone: 'UTC', timeZoneSource: 'host' }),
              updateSettings: vi.fn(async () => ({})),
              setModelDefaults: vi.fn(async () => ({})),
              ...api,
            } as unknown as GatewayApi
          }
          profile={profile}
          project={null}
          opened={opened}
          sent={sent}
          refresh={() => {}}
        />
      </QueryClientProvider>,
    ),
  );
};
const field = () => element.querySelector('textarea') as HTMLTextAreaElement;
const type = async (text: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const press = async () => {
  await act(async () => {
    element
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
};
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 5)));

beforeEach(() => {
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver:
      globalThis.ResizeObserver ??
      class {
        observe() {}
        disconnect() {}
      },
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useDrafts.setState({ texts: {} });
  opened.mockClear();
  sent.mockClear();
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});

it('shows the message the moment it is sent, before the gateway has made the chat', async () => {
  const creating = deferred<typeof session>();
  const send = vi.fn(async () => ({ id: 'run' }));
  await render({
    createGatewaySession: vi.fn(() => creating.promise) as never,
    renameSession: vi.fn(async () => session) as never,
    send: send as never,
  });
  await type('Plan the release');
  await press();

  // Nothing has answered yet, and it is already in the conversation with the field empty.
  expect(element.textContent).toContain('Plan the release');
  expect(field().value).toBe('');
  expect(send).not.toHaveBeenCalled();
  expect(opened).not.toHaveBeenCalled();

  await act(async () => creating.resolve(session));
  await flush();

  expect(send).toHaveBeenCalledOnce();
  expect(opened).toHaveBeenCalledWith(session.id);
  // The conversation opens holding it, so nothing has to load before it shows.
  const seeded = client.getQueryData<{ messages: { content: string }[] }>([
    'history',
    profile.id,
    session.id,
  ]);
  expect(seeded?.messages[0]?.content).toBe('Plan the release');
  expect(useDrafts.getState().texts).toEqual({});
});

it('keeps the message when the gateway fails, and retries it as the same message', async () => {
  const create = vi.fn(async () => {
    if (create.mock.calls.length === 1) throw new Error('The gateway did not answer.');
    return session;
  });
  const send = vi.fn(async () => ({ id: 'run' }));
  await render({
    createGatewaySession: create as never,
    renameSession: vi.fn(async () => session) as never,
    send: send as never,
  });
  await type('Plan the release');
  await press();
  await flush();

  expect(element.textContent).toContain('This message was not sent');
  expect(element.textContent).toContain('The gateway did not answer.');
  expect(element.textContent).toContain('Plan the release');
  expect(opened).not.toHaveBeenCalled();
  // A crash now still finds the words: they are saved until the gateway has them.
  expect(Object.values(useDrafts.getState().texts)).toEqual(['Plan the release']);

  const retry = [...element.querySelectorAll('button')].find(
    (button) => button.textContent === 'Try again',
  );
  await act(async () => retry?.click());
  await flush();

  expect(create).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledOnce();
  expect(opened).toHaveBeenCalledWith(session.id);
});

it('does not send twice a message whose answer got lost', async () => {
  const send = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  send.mockRejectedValueOnce(new Error('Connection lost.'));
  send.mockResolvedValueOnce({ id: 'run' });
  await render({
    createGatewaySession: vi.fn(async () => session) as never,
    renameSession: vi.fn(async () => session) as never,
    send: send as never,
  });
  await type('Only once');
  await press();
  await flush();
  const retry = [...element.querySelectorAll('button')].find(
    (button) => button.textContent === 'Try again',
  );
  await act(async () => retry?.click());
  await flush();

  // The same key both times: the gateway takes a repeat as the message it already has.
  expect(send.mock.calls[0]?.[4]).toBe(send.mock.calls[1]?.[4]);
});

it('gives the message back to change it, and opens no chat', async () => {
  await render({
    createGatewaySession: vi.fn(async () => {
      throw new Error('No gateway.');
    }) as never,
  });
  await type('Plan the release');
  await press();
  await flush();

  await act(async () => element.querySelector<HTMLButtonElement>('.trouble-close')?.click());

  expect(field().value).toBe('Plan the release');
  expect(element.textContent).not.toContain('This message was not sent');
  expect(opened).not.toHaveBeenCalled();
});

it('hands the Inspector over to the chat the draft becomes', async () => {
  const adopt = vi.spyOn(useCrew.getState(), 'adopt');
  await render({
    createGatewaySession: vi.fn(async () => session) as never,
    renameSession: vi.fn(async () => session) as never,
    send: vi.fn(async () => ({ id: 'run' })) as never,
  });
  await type('Plan the release');
  await press();
  await flush();

  expect(adopt).toHaveBeenCalledWith(session.id);
  adopt.mockRestore();
});

it('delivers the message but leaves the owner where they went', async () => {
  const sending = deferred<{ id: string }>();
  await render({
    createGatewaySession: vi.fn(async () => session) as never,
    renameSession: vi.fn(async () => session) as never,
    send: vi.fn(() => sending.promise) as never,
  });
  await type('Plan the release');
  await press();
  await flush();

  await act(async () => root.unmount());
  await act(async () => sending.resolve({ id: 'run' }));
  await flush();

  expect(opened).not.toHaveBeenCalled();
  root = createRoot(element);
});

const model = {
  providerId: 'provider',
  modelId: 'atlas-large',
  reasoningEffort: 'high',
  fast: true,
};

it('leaves its model, effort, speed and protection for the next new chat', async () => {
  const setModelDefaults = vi.fn(async () => ({}));
  const updateSettings = vi.fn(async () => ({}));
  const before = {
    conversation: null,
    channel: { providerId: 'provider', modelId: 'atlas-small' },
    updatedAt: '2026-10-31T10:00:00Z',
  };
  client.setQueryData(keys.modelDefaults, before);
  chosen.model = model;
  chosen.protection = 'full';
  await render({
    createGatewaySession: vi.fn(async () => session) as never,
    renameSession: vi.fn(async () => session) as never,
    send: vi.fn(async () => ({ id: 'run' })) as never,
    setSessionModel: vi.fn(async () => session) as never,
    setSessionProtection: vi.fn(async () => session) as never,
    setModelDefaults: setModelDefaults as never,
    updateSettings: updateSettings as never,
  });
  await flush();
  await act(async () => applyChoices());
  await type('Plan the release');
  await press();
  await flush();

  // Only what a chat chooses moves; a channel's own model is not touched.
  expect(setModelDefaults).toHaveBeenCalledWith({
    conversation: model,
    channel: before.channel,
  });
  expect(updateSettings).toHaveBeenCalledWith({ newChatProtection: 'full' });
  expect(client.getQueryData<{ conversation: unknown }>(keys.modelDefaults)?.conversation).toEqual(
    model,
  );
});

it('changes nothing when the message did not reach the gateway', async () => {
  const setModelDefaults = vi.fn(async () => ({}));
  const updateSettings = vi.fn(async () => ({}));
  client.setQueryData(keys.modelDefaults, { conversation: null, updatedAt: 'now' });
  chosen.model = model;
  chosen.protection = 'full';
  await render({
    createGatewaySession: vi.fn(async () => {
      throw new Error('No gateway.');
    }) as never,
    setModelDefaults: setModelDefaults as never,
    updateSettings: updateSettings as never,
  });
  await flush();
  await act(async () => applyChoices());
  await type('Plan the release');
  await press();
  await flush();

  expect(setModelDefaults).not.toHaveBeenCalled();
  expect(updateSettings).not.toHaveBeenCalled();
});

it('starts from the protection the last new chat left', async () => {
  chosen.model = undefined;
  chosen.protection = undefined;
  await render({
    settings: (async () => ({
      timeZone: 'UTC',
      timeZoneSource: 'host',
      newChatProtection: 'auto',
    })) as never,
  });
  await flush();

  expect(element.querySelector('[data-protection]')?.getAttribute('data-protection')).toBe('auto');
});

it('sends this chat its choices, and still sends when remembering them fails', async () => {
  const setSessionProtection = vi.fn(async () => session);
  const send = vi.fn(async () => ({ id: 'run' }));
  client.setQueryData(keys.modelDefaults, { conversation: null, updatedAt: 'now' });
  chosen.model = model;
  chosen.protection = 'auto';
  await render({
    createGatewaySession: vi.fn(async () => session) as never,
    renameSession: vi.fn(async () => session) as never,
    setSessionModel: vi.fn(async () => session) as never,
    setSessionProtection: setSessionProtection as never,
    send: send as never,
    setModelDefaults: vi.fn(async () => {
      throw new Error('Older gateway.');
    }) as never,
    updateSettings: vi.fn(async () => {
      throw new Error('Older gateway.');
    }) as never,
  });
  await flush();
  await act(async () => applyChoices());
  await type('Plan the release');
  await press();
  await flush();

  expect(setSessionProtection).toHaveBeenCalledWith(profile.id, session.id, 'auto');
  expect(send).toHaveBeenCalledOnce();
  expect(opened).toHaveBeenCalledWith(session.id);
});
