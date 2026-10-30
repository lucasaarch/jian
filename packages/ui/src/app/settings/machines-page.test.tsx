import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi } from '../../lib/api';
import { MachinesPage, type ThisComputer } from './machines-page';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const actions = vi.hoisted(() => ({ api: {} as GatewayApi }));
vi.mock('../../lib/workspace', () => ({
  useActions: () => ({ api: actions.api, mutate: async () => true, busy: false }),
}));

const machine = {
  id: '7c2f4e6a-1b3d-4c5e-8f90-a1b2c3d4e5f6',
  name: 'Studio Mac',
  platform: 'darwin-arm64',
  system: 'macOS 27.2' as string | null,
  online: true,
  createdAt: '2026-10-29T12:00:00Z',
  capabilities: [],
  uiState: 'unlocked' as const,
  version: '1.4.0',
  outdated: false,
  updatable: true,
};
const token = 'synthetic-worker-token-that-is-long-enough-1234';

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function render(api: Partial<GatewayApi>, thisComputer?: ThisComputer) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  actions.api = {
    releases: async () => ({ version: '1.4.0', notes: [], unseen: [] }),
    ...api,
  } as unknown as GatewayApi;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MachinesPage thisComputer={thisComputer} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

const button = (name: string) =>
  [...document.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );
const type = (input: HTMLInputElement | null | undefined, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });

it('registers a machine and shows its install command once', async () => {
  const createRemoteMachine = vi.fn(async () => ({ ...machine, token }));
  await render({ remoteMachines: async () => [], createRemoteMachine });

  await act(async () => button('Add')?.click());
  await type(document.querySelector<HTMLInputElement>('form input'), 'Studio Mac');
  await act(async () => button('Create machine')?.click());

  expect(createRemoteMachine).toHaveBeenCalledWith({ name: 'Studio Mac' });
  expect([...document.querySelectorAll('code')].map((code) => code.textContent)).toContain(
    `npm install -g @jian-ai/remote-control@1.4.0 && jian-remote install --gateway '${window.location.origin}' --machine '${machine.id}' --token '${token}'`,
  );
});

it('removes a machine only once its name is typed', async () => {
  const deleteRemoteMachine = vi.fn(async () => ({ id: machine.id }));
  await render({ remoteMachines: async () => [machine], deleteRemoteMachine });

  await act(async () => button('Configure Studio Mac')?.click());
  await act(async () => button('Remove')?.click());
  const confirm = button('Remove machine');
  expect(confirm?.disabled).toBe(true);

  await type([...document.querySelectorAll<HTMLInputElement>('form input')].at(-1), 'Studio Mac');
  await act(async () => confirm?.click());

  expect(deleteRemoteMachine).toHaveBeenCalledWith(machine.id);
});

const other = { ...machine, id: '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f', name: 'Build box' };

it('lists the computer the app runs on first, with its switch and without its credentials', async () => {
  let refuse!: (reason: Error) => void;
  const setSharing = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        refuse = reject;
      }),
  );
  await render(
    { remoteMachines: async () => [other, machine] },
    { machineId: machine.id, sharing: true, setSharing },
  );
  const rows = [...document.querySelectorAll('button[aria-label^="Configure"]')].map((item) =>
    item.getAttribute('aria-label'),
  );
  expect(rows).toEqual(['Configure Studio Mac', 'Configure Build box']);
  expect(document.body.textContent).toContain('This computer');
  // What it is, at a glance: its system as its worker reported it, and its architecture.
  expect(document.body.textContent).toContain('macOS 27.2 · arm64');

  const toggle = () =>
    document.querySelector<HTMLElement>('[aria-label="Let agents use this computer"]');
  await act(async () => toggle()?.click());
  // Off at once, while the app is asked; back on when it refuses.
  expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  expect(setSharing).toHaveBeenCalledWith(false);
  await act(async () => refuse(new Error('Could not save.')));
  expect(toggle()?.getAttribute('aria-checked')).toBe('true');

  // The app keeps it registered and holds its token: neither is offered for it.
  await act(async () => button('Configure Studio Mac')?.click());
  expect(button('Remove')).toBeUndefined();
  expect(button('Rotate credentials for Studio Mac')).toBeUndefined();
});

it('says this computer is connecting before the app has registered it', async () => {
  await render(
    { remoteMachines: async () => [other] },
    { machineId: null, sharing: true, setSharing: vi.fn(async () => {}) },
  );

  expect(document.body.textContent).toContain('This computer');
  expect(document.body.textContent).toContain('Connecting');
  expect(document.body.textContent).not.toContain('None yet');
});

it('gives the install command again after a rotation, with the new token', async () => {
  const rotated = 'synthetic-rotated-token-that-is-long-enough-5678';
  const rotateRemoteMachineCredentials = vi.fn(async () => ({ ...machine, token: rotated }));
  await render({
    remoteMachines: async () => [{ ...machine, online: false }],
    rotateRemoteMachineCredentials,
  });

  await act(async () => button('Configure Studio Mac')?.click());
  await act(async () => button('Rotate credentials for Studio Mac')?.click());
  await act(async () => button('Rotate credentials')?.click());

  // Rotating is how a lost install command is had again: the worker may not be there at all.
  expect(rotateRemoteMachineCredentials).toHaveBeenCalledWith(machine.id);
  expect([...document.querySelectorAll('code')].map((code) => code.textContent)).toContain(
    `npm install -g @jian-ai/remote-control@1.4.0 && jian-remote install --gateway '${window.location.origin}' --machine '${machine.id}' --token '${rotated}'`,
  );
});

it('marks a machine on another release and updates it from the panel', async () => {
  let version = '1.3.2';
  const updateRemoteMachine = vi.fn(async () => {
    version = '1.4.0';
    return {
      ok: true,
      from: '1.3.2',
      to: '1.4.0',
      message: 'Updated Jian Remote from 1.3.2 to 1.4.0.',
    };
  });
  await render({
    remoteMachines: async () => [
      { ...machine, capabilities: ['update-npm'], version, outdated: version !== '1.4.0' },
    ],
    updateRemoteMachine,
  });
  expect(document.body.textContent).toContain('Update needed');

  await act(async () => button('Configure Studio Mac')?.click());
  await act(async () => button('Update')?.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  expect(updateRemoteMachine).toHaveBeenCalledWith(machine.id);
  expect(document.body.textContent).toContain('Updated Jian Remote from 1.3.2 to 1.4.0.');
  expect(document.body.textContent).not.toContain('Update needed');
});
