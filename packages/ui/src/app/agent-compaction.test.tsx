import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Profile } from '../lib/api';
import { AgentCache } from '../test/agent';
import { profile as base } from '../test/fixtures';
import { AgentCompaction } from './agent-compaction';
import { AgentIdentity } from './agent-identity';

const gateway = vi.hoisted(() => ({ updateProfile: vi.fn() }));
vi.mock('../lib/query/client', () => ({ panelApi: () => gateway }));

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function render(compactAt: Profile['contextPolicy']['compactAt'] = 'auto') {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const profile = { ...base, contextPolicy: { ...base.contextPolicy, compactAt } };
  let version = profile.version;
  const saves: Record<string, unknown>[] = [];
  gateway.updateProfile.mockImplementation(async (_id: string, body: Record<string, unknown>) => {
    saves.push(body);
    version += 1;
    return { ...profile, version };
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache profile={profile}>
        <AgentCompaction profile={profile} />
      </AgentCache>,
    ),
  );

  const press = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
    if (!button) throw new Error(`No ${label} button`);
    await act(async () => button.click());
  };
  const type = async (value: string) => {
    const input = host.querySelector('input');
    if (!input) throw new Error('No size field');
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, 'value')?.set?.call(
      input,
      value,
    );
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
  };
  const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  return { host, saves, press, type, wait, profile };
}

it('starts near the limit and saves a set size with the rest of the policy as it was', async () => {
  const { host, saves, press, wait, profile } = await render();

  expect(host.querySelector('input')).toBeNull();
  await press('At a set size');
  await wait(1000);
  expect(saves[0]).toEqual({
    expectedVersion: 3,
    contextPolicy: { ...profile.contextPolicy, compactAt: 200_000 },
  });

  await press('400K');
  await wait(1000);
  expect(saves[1]).toMatchObject({ expectedVersion: 4, contextPolicy: { compactAt: 400_000 } });
  expect(host.querySelector('input')?.value).toBe('400,000');
});

it('takes a typed size, and goes back to near the limit', async () => {
  const { saves, press, type, wait } = await render(600_000);

  await type('350,000');
  await wait(1000);
  expect(saves[0]).toMatchObject({ contextPolicy: { compactAt: 350_000 } });

  await press('Near the limit');
  await wait(1000);
  expect(saves[1]).toMatchObject({ contextPolicy: { compactAt: 'auto' } });
});

it('holds back a size the gateway would refuse, and says why', async () => {
  const { host, saves, type, wait } = await render(600_000);

  for (const [typed, reason] of [
    ['10000', 'At least 50,000 tokens'],
    ['30,000,000', 'At most 20,000,000 tokens'],
    ['lots', 'Write a whole number of tokens'],
    ['', 'Write a whole number of tokens'],
  ]) {
    await type(typed as string);
    await wait(1000);
    expect(host.textContent).toContain(reason);
  }
  expect(saves).toEqual([]);
});

it('names the size field on its own', async () => {
  const { host, press } = await render();

  await press('At a set size');
  const input = host.querySelector('input');
  expect(document.getElementById(input?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe(
    'Size in tokens',
  );
});

it('saves after the identity card, against the version its save returned', async () => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const profile = { ...base, id: 'b6c0c7a4-0c1e-4b44-9a7e-2f0d3c1e5a10', version: 7 };
  const saves: Record<string, unknown>[] = [];
  let version = profile.version;
  // A save that takes a while, so the second card's save is asked for while the first is out.
  gateway.updateProfile.mockImplementation(async (_id: string, body: Record<string, unknown>) => {
    saves.push(body);
    await new Promise((resolve) => setTimeout(resolve, 500));
    version += 1;
    return { ...profile, version };
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache profile={profile}>
        <AgentIdentity profile={profile} />
        <AgentCompaction profile={profile} />
      </AgentCache>,
    ),
  );

  const name = host.querySelector('input');
  if (!name) throw new Error('No name field');
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(name) as object, 'value')?.set?.call(
    name,
    'Zero Three',
  );
  await act(async () => name.dispatchEvent(new Event('input', { bubbles: true })));
  const set = [...host.querySelectorAll('button')].find(
    (item) => item.textContent === 'At a set size',
  );
  await act(async () => set?.click());
  await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));

  expect(saves).toHaveLength(2);
  expect(saves.map((save) => save.expectedVersion)).toEqual([7, 8]);
});
