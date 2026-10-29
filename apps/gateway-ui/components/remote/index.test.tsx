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
