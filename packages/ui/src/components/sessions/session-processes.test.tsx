// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentProcess } from '../../lib/api';
import { useCrew } from '../../lib/stores/crew';
import { SessionProcesses } from './session-processes';

const process = (id: string, extra: Partial<AgentProcess> = {}): AgentProcess => ({
  id,
  sessionId: 'session',
  command: `npm run dev -- --port ${id}`,
  cwd: '/work',
  startedAt: new Date(Date.now() - 65_000).toISOString(),
  status: 'running',
  ...extra,
});

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
  useCrew.setState({ tabs: [], following: undefined, opened: false });
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  document.body.innerHTML = '';
});

const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

const show = async (list: AgentProcess[]) => {
  const stopSessionProcess = vi.fn(async () => list[0] as AgentProcess);
  const api = { sessionProcesses: async () => list, stopSessionProcess };
  await act(async () =>
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SessionProcesses api={api} profileId="profile" sessionId="session" />
      </QueryClientProvider>,
    ),
  );
  await tick();
  return stopSessionProcess;
};

const trigger = () => element.querySelector<HTMLElement>('.session-badge-trigger');
const open = async () => {
  await act(async () => trigger()?.click());
  await tick();
};

it('shows nothing while no process runs, and ended ones do not count', async () => {
  await show([]);
  expect(trigger()).toBeNull();

  await show([
    process('a', { status: 'exited', exitCode: 0 }),
    process('b', { status: 'stopped' }),
  ]);
  expect(trigger()).toBeNull();
});

it('counts the running ones and lists them with how long they have run', async () => {
  await show([process('a'), process('b'), process('c', { status: 'exited', exitCode: 1 })]);
  expect(trigger()?.textContent).toBe('2 processes');

  await open();
  const rows = document.querySelectorAll('.session-process');
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain('npm run dev -- --port a');
  expect(rows[0]?.textContent).toMatch(/1:0\d/);
});

it('stops one from its row without opening it', async () => {
  const stop = await show([process('a')]);
  await open();

  await act(async () =>
    document.querySelector<HTMLElement>('[aria-label^="Stop npm run dev"]')?.click(),
  );

  expect(stop).toHaveBeenCalledWith('profile', 'session', 'a');
  expect(useCrew.getState().tabs).toEqual([]);
});

it('opens its output in the Inspector from the row', async () => {
  await show([process('a')]);
  await open();

  await act(async () => document.querySelector<HTMLElement>('.session-process-open')?.click());

  const state = useCrew.getState();
  expect(state.following).toBe('process:a');
  expect(state.tabs).toEqual([
    { key: 'process:a', kind: 'process', processId: 'a', title: 'npm run dev -- --port a' },
  ]);
  expect(state.opened).toBe(true);
});
