import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GatewayApi } from '../../lib/api';
import { RemoteMachines } from '.';

const machine = '7c2f4e6a-1b3d-4c5e-8f90-a1b2c3d4e5f6';
const token = 'synthetic-worker-token-that-is-long-enough-1234';

it('adds a machine for every agent and shows one install command', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  const createRemoteMachine = vi.fn(async () => ({
    id: machine,
    name: 'Studio Mac',
    platform: 'unknown',
    online: false,
    createdAt: '2026-10-29T12:00:00Z',
    capabilities: [],
    uiState: 'unknown' as const,
    token,
  }));
  const api = {
    remoteMachines: async () => [],
    releases: async () => ({ version: '1.4.0', notes: [], unseen: [] }),
    createRemoteMachine,
  } as unknown as GatewayApi;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <RemoteMachines api={api} />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      [...element.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Add machine'))
        ?.click();
    });
    // No agent to choose: the form asks for a name only.
    expect(document.body.textContent).not.toContain('Agents allowed');
    const name = document.querySelector<HTMLInputElement>('#create-remote-machine input');
    await act(async () => {
      if (!name) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        name,
        'Studio Mac',
      );
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      document
        .querySelector('form#create-remote-machine')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(createRemoteMachine).toHaveBeenCalledWith({ name: 'Studio Mac' });
    const commands = [
      ...document.querySelectorAll<HTMLTextAreaElement>('.remote-created textarea'),
    ];
    expect(commands.map((command) => command.value)).toEqual([
      `npm install -g @jian-ai/remote-control@1.4.0 && jian-remote install --gateway '${window.location.origin}' --machine '${machine}' --token '${token}'`,
    ]);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('gives the same install command again after a rotation, with the new token', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  const rotated = 'synthetic-rotated-token-that-is-long-enough-5678';
  const api = {
    remoteMachines: async () => [
      {
        id: machine,
        name: 'Studio Mac',
        platform: 'darwin-arm64',
        online: false,
        createdAt: '2026-10-29T12:00:00Z',
        capabilities: [],
        uiState: 'unknown' as const,
      },
    ],
    releases: async () => ({ version: '1.4.0', notes: [], unseen: [] }),
    rotateRemoteMachineCredentials: vi.fn(async () => ({ id: machine, token: rotated })),
  } as unknown as GatewayApi;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const press = (text: string) =>
    act(async () => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === text)
        ?.click();
    });

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <RemoteMachines api={api} />
        </QueryClientProvider>,
      );
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await press('Manage');
    await press('Rotate credentials');
    await press('Confirm');

    // Rotating is how a lost install command is had again: the worker may not be there at all.
    expect(
      [...document.querySelectorAll<HTMLTextAreaElement>('.remote-created textarea')].map(
        (command) => command.value,
      ),
    ).toEqual([
      `npm install -g @jian-ai/remote-control@1.4.0 && jian-remote install --gateway '${window.location.origin}' --machine '${machine}' --token '${rotated}'`,
    ]);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('marks a machine on another release and updates it from the panel', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
  const api = {
    remoteMachines: async () => [
      {
        id: machine,
        name: 'Studio Mac',
        platform: 'darwin-arm64',
        online: true,
        createdAt: '2026-10-29T12:00:00Z',
        capabilities: ['update-npm'],
        uiState: 'unlocked' as const,
        version,
        outdated: version !== '1.4.0',
        updatable: true,
      },
    ],
    releases: async () => ({ version: '1.4.0', notes: [], unseen: [] }),
    updateRemoteMachine,
  } as unknown as GatewayApi;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const press = (text: string) =>
    act(async () => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === text)
        ?.click();
    });

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <RemoteMachines api={api} />
        </QueryClientProvider>,
      );
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(element.textContent).toContain('Update needed');
    await press('Manage');
    expect(element.textContent).toContain('Agents cannot use it until it is updated.');
    await press('Update');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(updateRemoteMachine).toHaveBeenCalledWith(machine);
    expect(element.textContent).toContain('Updated Jian Remote from 1.3.2 to 1.4.0.');
    expect(element.textContent).not.toContain('Update needed');
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
