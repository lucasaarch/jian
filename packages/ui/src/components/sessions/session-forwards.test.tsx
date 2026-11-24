// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GatewayApi } from '../../lib/api';
import { SessionForwards } from './session-forwards';

type Forward = Awaited<ReturnType<GatewayApi['sessionForwards']>>[number];

const forward = (extra: Partial<Forward> = {}): Forward => ({
  id: '7d1c2f0e-4a59-4c11-9a52-1f1b5e7d3c10',
  sessionId: '6f1c2f0e-4a59-4c11-9a52-1f1b5e7d3c10',
  machineId: '0b6f6a1e-3f0e-4c55-8a7e-2d9f4c1b7a21',
  machineName: 'Studio Mac',
  remotePort: 3000,
  status: 'open',
  localPort: 41234,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  document.body.innerHTML = '';
});

const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

const show = async (list: Forward[] | Error) => {
  const closeForward = vi.fn(async () => undefined);
  const api = {
    sessionForwards: async () => {
      if (list instanceof Error) throw list;
      return list;
    },
    closeForward,
  } as unknown as Pick<GatewayApi, 'sessionForwards' | 'closeForward'>;
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SessionForwards api={api} profileId="profile" sessionId="session" />
      </QueryClientProvider>,
    ),
  );
  await tick();
  return closeForward;
};

const trigger = () => element.querySelector<HTMLElement>('.session-badge-trigger');
const open = async () => {
  await act(async () => trigger()?.click());
  await tick();
};

it('shows nothing without a forward, or on a gateway that cannot answer', async () => {
  await show([]);
  expect(trigger()).toBeNull();

  await act(async () => root.unmount());
  root = createRoot(element);
  await show(new Error('Not found'));
  expect(trigger()).toBeNull();
});

it('names the port of one forward and counts several', async () => {
  await show([forward()]);
  expect(trigger()?.textContent).toBe(':3000');

  await act(async () => root.unmount());
  root = createRoot(element);
  await show([
    forward(),
    forward({ id: '8d1c2f0e-4a59-4c11-9a52-1f1b5e7d3c10', remotePort: 5173 }),
  ]);
  expect(trigger()?.textContent).toBe('2 ports');
});

it('opens the address of an open forward and says why one failed', async () => {
  await show([
    forward(),
    forward({
      id: '8d1c2f0e-4a59-4c11-9a52-1f1b5e7d3c10',
      status: 'failed',
      localPort: undefined,
      error: 'No free port',
    }),
  ]);
  await open();

  const link = document.querySelector<HTMLAnchorElement>('a.session-pull');
  expect(link?.getAttribute('href')).toBe('http://localhost:41234');
  expect(link?.textContent).toContain('Studio Mac');
  expect(document.body.textContent).toContain('Failed');
  expect(document.body.textContent).toContain('No free port');
});

it('stops the forward the owner chose', async () => {
  const closeForward = await show([forward()]);
  await open();

  await act(async () =>
    document.querySelector<HTMLElement>('[aria-label="Stop forwarding port 3000"]')?.click(),
  );

  expect(closeForward).toHaveBeenCalledWith('profile', forward().id);
});
