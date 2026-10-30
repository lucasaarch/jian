import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi, ProfileStats } from '../../lib/api';
import { AgentCache } from '../../test/agent';
import { profile, statsFor } from '../../test/fixtures';
import { OverviewContent } from './overview-content';
import { ChannelCards, ModelCards, UsageSummary } from './usage';

// The cache tells its readers on the next tick, not within the one that answered.
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function render(ui: React.ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () => root.render(<AgentCache profile={profile}>{ui}</AgentCache>));
  return host;
}

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);

it('shows nothing of the overview, nor reads the year, until the numbers arrive', async () => {
  let answer: (stats: ProfileStats) => void = () => {};
  const api = {
    stats: () => new Promise<ProfileStats>((resolve) => (answer = resolve)),
    activityCalendar: vi.fn(async () => []),
  } as unknown as GatewayApi;
  const host = await render(<OverviewContent api={api} />);

  expect(host.querySelector('[role="status"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Usage"]')).toBeNull();
  expect(api.activityCalendar).not.toHaveBeenCalled();

  await act(async () => answer(statsFor(30) as ProfileStats));
  await settle();

  expect(host.querySelector('[aria-label="Usage"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Activity"]')).not.toBeNull();
  expect(api.activityCalendar).toHaveBeenCalled();
});

it('offers to read again when the numbers could not be read', async () => {
  const stats = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(statsFor(30));
  const api = { stats, activityCalendar: async () => [] } as unknown as GatewayApi;
  const host = await render(<OverviewContent api={api} />);
  await settle();

  expect(host.textContent).toContain('The overview could not be read.');
  await act(async () => button(host, 'Try again')?.click());
  await settle();

  expect(stats).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[aria-label="Usage"]')).not.toBeNull();
});

it('reads the usage again over the period chosen', async () => {
  const stats = vi.fn(async (_profile: string, days: number) => statsFor(days));
  const api = { stats, activityCalendar: async () => [] } as unknown as GatewayApi;
  const host = await render(<OverviewContent api={api} />);
  await settle();

  await act(async () => button(host, '7 days')?.click());
  await settle();

  expect(stats).toHaveBeenLastCalledWith(profile.id, 7);
});

it('names Meta’s WhatsApp apart from Baileys and from the API server', async () => {
  const stats = {
    ...statsFor(30),
    channels: [
      { channel: 'whatsapp-business', turns: 1, conversations: 1, tokens: 100 },
      { channel: 'whatsapp', turns: 1, conversations: 1, tokens: 100 },
    ],
  } as ProfileStats;
  const host = await render(<ChannelCards stats={stats} />);

  expect(host.textContent).toContain('WhatsApp Business (Meta)');
  expect(host.textContent).toContain('WhatsApp (Baileys)');
  expect(host.textContent).not.toContain('API Server');
});

it('keeps a long model history short until the owner asks for all of it', async () => {
  const sample = statsFor(30);
  const stats = {
    ...sample,
    models: Array.from({ length: 50 }, (_, index) => ({
      ...sample.models[0],
      modelId: `model-${index}`,
    })),
  } as ProfileStats;
  const host = await render(<ModelCards stats={stats} />);
  const cards = () => host.querySelectorAll('[aria-label="Model usage"] > li');

  expect(cards()).toHaveLength(4);
  await act(async () => button(host, 'Show all 50 models')?.click());
  expect(cards()).toHaveLength(50);
});

it('shows a subscription’s windows only where the provider reports them', async () => {
  const host = await render(<UsageSummary stats={statsFor(30) as ProfileStats} />);
  const limits = () => host.querySelector('[aria-label="Subscription limits"]');

  // Codex reports its weekly window; Claude is unavailable here and left out.
  expect(limits()?.textContent).toContain('Weekly window');
  expect(limits()?.textContent).toContain('32% used');
  expect(limits()?.textContent).not.toContain('5-hour window');
  expect(limits()?.querySelectorAll('li')).toHaveLength(1);

  const unavailable = {
    ...statsFor(30),
    subscriptions: [{ provider: 'codex', status: 'unavailable', fiveHour: null, weekly: null }],
  } as ProfileStats;
  const other = await render(<UsageSummary stats={unavailable} />);
  expect(other.querySelector('[aria-label="Subscription limits"]')).toBeNull();
});
