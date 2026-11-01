import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { keys } from '../../lib/query/keys';
import { SubscriptionMeter } from './subscription-meter';

let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

async function show(usage: unknown[]) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(keys.subscriptionUsage, usage);
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <SubscriptionMeter />
      </QueryClientProvider>,
    ),
  );
  return host;
}

const window = (usedPercent: number) => ({ usedPercent, resetsAt: '2026-11-03T14:00:00.000Z' });

it('shows the window closest to running out, and each of them when opened', async () => {
  const host = await show([
    { provider: 'claude', status: 'available', fiveHour: window(12), weekly: window(40) },
    { provider: 'codex', status: 'available', fiveHour: null, weekly: window(84) },
  ]);

  expect(host.textContent).toBe('40%84%');
  await act(async () => host.querySelector('button')?.click());

  const opened = document.body.textContent;
  expect(opened).toContain('5-hour window');
  expect(opened).toContain('12% used');
  expect(opened).toContain('Weekly window');
  expect(opened).toContain('84% used');
  expect(opened).toContain('Resets');
});

it('leaves out a subscription that has not said anything yet', async () => {
  const host = await show([
    { provider: 'claude', status: 'unavailable', fiveHour: null, weekly: null },
    { provider: 'codex', status: 'available', fiveHour: null, weekly: window(84) },
  ]);

  expect(host.textContent).toBe('84%');
  await act(async () => host.querySelector('button')?.click());
  expect(document.body.textContent).not.toContain('Claude');
});

it('shows nothing when no subscription has said anything', async () => {
  const host = await show([
    { provider: 'claude', status: 'unavailable', fiveHour: null, weekly: null },
  ]);

  expect(host.textContent).toBe('');
});
