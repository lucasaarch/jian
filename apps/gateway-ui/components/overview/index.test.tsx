import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AgentCache } from '@/test/agent';
import { profile, statsFor } from '@/test/fixtures';
import type { GatewayApi, ProfileStats } from '../../lib/api';
import { Overview } from '.';

// The cache tells its readers on the next tick, not within the one that answered.
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

it('waits for stats before showing any overview content', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let resolveStats: (stats: ProfileStats) => void = () => {};
  const api = {
    stats: () => new Promise<ProfileStats>((resolve) => (resolveStats = resolve)),
    activityCalendar: vi.fn(async () => []),
  } as unknown as GatewayApi;
  const element = document.createElement('div');
  const root = createRoot(element);

  await act(async () =>
    root.render(
      <AgentCache profile={profile}>
        <Overview api={api} />
      </AgentCache>,
    ),
  );
  expect(element.querySelector('[aria-label="Loading overview"]')).not.toBeNull();
  expect(element.querySelector('.overview-profile')).toBeNull();
  expect(element.querySelector('.heatmap-panel')).toBeNull();
  expect(api.activityCalendar).not.toHaveBeenCalled();

  await act(async () => resolveStats(statsFor(30) as ProfileStats));
  await settle();
  expect(element.querySelector('.overview-profile')).not.toBeNull();
  expect(element.querySelector('.stat-subscriptions')).not.toBeNull();
  expect(element.querySelector('.heatmap-panel')).not.toBeNull();

  await act(async () => root.unmount());
});

it('offers retry if the first stats load fails', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const stats = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(statsFor(30));
  const api = { stats, activityCalendar: async () => [] } as unknown as GatewayApi;
  const element = document.createElement('div');
  const root = createRoot(element);

  await act(async () =>
    root.render(
      <AgentCache profile={profile}>
        <Overview api={api} />
      </AgentCache>,
    ),
  );
  await settle();
  expect(element.textContent).toContain('Could not load overview.');
  expect(element.querySelector('.overview-profile')).toBeNull();

  await act(async () => element.querySelector<HTMLButtonElement>('button')?.click());
  await settle();
  expect(stats).toHaveBeenCalledTimes(2);
  expect(element.querySelector('.overview-profile')).not.toBeNull();

  await act(async () => root.unmount());
});
