import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Profile } from '../lib/api';
import { AgentCache } from '../test/agent';
import { AgentIdentity } from './agent-identity';

const gateway = vi.hoisted(() => ({ updateProfile: vi.fn() }));
vi.mock('../lib/query/client', () => ({ panelApi: () => gateway }));

const profile = {
  id: 'p1',
  name: 'Zero Two',
  instructions: 'Help.',
  summary: '',
  avatar: null,
  identity: { role: 'Assistant', tone: '', goals: ['Close loops'], boundaries: [] },
  allowShell: false,
  version: 3,
} as unknown as Profile;

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function render() {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
        <AgentIdentity profile={profile} />
      </AgentCache>,
    ),
  );

  /** The field a row's title names, as a screen reader finds it. */
  const field = (title: string) =>
    [...host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].find(
      (item) =>
        document.getElementById(item.getAttribute('aria-labelledby') ?? '')?.textContent === title,
    );
  const type = async (title: string, value: string) => {
    const input = field(title);
    if (!input) throw new Error(`No ${title} field`);
    // React tracks the value itself; the native setter is what a keystroke goes through.
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, 'value')?.set?.call(
      input,
      value,
    );
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
  };
  const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  return { host, saves, type, wait };
}

it('saves once typing pauses, each save sending the version the last one returned', async () => {
  const { saves, type, wait } = await render();

  await type('Name', 'Zero');
  await type('Name', 'Zero Two!');
  await wait(300);
  expect(saves).toEqual([]);

  await wait(800);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ name: 'Zero Two!', expectedVersion: 3 });

  await type('Summary', 'Assistant');
  await wait(900);
  expect(saves[1]).toMatchObject({ summary: 'Assistant', expectedVersion: 4 });
});

it('never saves an empty name', async () => {
  const { saves, type, wait } = await render();

  await type('Name', '');
  await wait(1000);

  expect(saves).toEqual([]);
});

it('saves boundaries a rule to a line, keeping the rest of the identity', async () => {
  const { saves, type, wait } = await render();

  await type('Boundaries', 'Never send money\n\n  Ask before writing to someone new  \n');
  await wait(1000);

  expect(saves[0]).toMatchObject({
    identity: {
      role: 'Assistant',
      tone: '',
      goals: ['Close loops'],
      boundaries: ['Never send money', 'Ask before writing to someone new'],
    },
  });
});

it('holds back more boundaries than the gateway keeps, and says why', async () => {
  const { host, saves, type, wait } = await render();

  await type('Boundaries', Array.from({ length: 11 }, (_, index) => `Rule ${index}`).join('\n'));
  await wait(1000);

  expect(saves).toEqual([]);
  expect(host.textContent).toContain('Ten boundaries at most');
});
