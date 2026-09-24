import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi, Profile } from '../../lib/api';

vi.mock('../../lib/workspace', () => ({
  useWorkspace: () => ({ deleteProfile: vi.fn(), refresh: vi.fn(async () => {}) }),
}));

const profile = {
  id: 'p1',
  name: 'Zero Two',
  instructions: 'Help.',
  summary: '',
  avatar: null,
  identity: { role: '', tone: '', goals: [], boundaries: [] },
  allowSelfManagement: false,
  allowShell: false,
  allowWebSearch: false,
  learnFromWork: true,
  version: 3,
} as unknown as Profile;

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function render() {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

  let version = profile.version;
  const saves: Array<Record<string, unknown>> = [];
  const api = {
    updateProfile: vi.fn(async (_id: string, body: Record<string, unknown>) => {
      saves.push(body);
      version += 1;

      return { ...profile, version };
    }),
  } as unknown as GatewayApi;

  const { ProfileEditor } = await import('./editor');
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  await act(async () => {
    root.render(<ProfileEditor profile={profile} api={api} busy={false} />);
  });

  const type = async (name: string, value: string) => {
    const field = element.querySelector<HTMLInputElement>(`[name="${name}"]`);

    if (!field) throw new Error(`No ${name} field`);

    // React tracks the value itself; the native setter is what a keystroke goes through.
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field) as object,
      'value',
    )?.set;

    setter?.call(field, value);
    await act(async () => {
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  return { element, saves, type, wait };
}

it('saves once typing pauses, each save sending the version the last one returned', async () => {
  const { saves, type, wait } = await render();

  await type('name', 'Zero');
  await type('name', 'Zero Two!');
  await wait(300);
  expect(saves).toEqual([]);

  await wait(800);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ name: 'Zero Two!', expectedVersion: 3 });

  await type('summary', 'Assistant');
  await wait(900);
  expect(saves[1]).toMatchObject({ summary: 'Assistant', expectedVersion: 4 });
});

it('saves a switch at once, and never an empty name', async () => {
  const { element, saves, type, wait } = await render();
  const shell = element.querySelector<HTMLInputElement>('[name="shell"]');

  await act(async () => shell?.click());
  await wait(10);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ allowShell: true });

  await type('name', '');
  await wait(1000);
  expect(saves).toHaveLength(1);
});
