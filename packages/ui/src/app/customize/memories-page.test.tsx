import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi, Memory, Project } from '../../lib/api';
import { AgentCache } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { MemoriesPage } from './memories-page';

const actions = vi.hoisted(() => ({ api: {} as GatewayApi }));
vi.mock('../../lib/workspace', () => ({
  useActions: () => ({
    api: actions.api,
    mutate: (action: () => Promise<unknown>) =>
      action().then(
        () => true,
        () => false,
      ),
    busy: false,
  }),
}));

const memory = (key: string, content: string, more: Partial<Memory> = {}) =>
  ({
    key,
    content,
    version: 2,
    links: [],
    projectIds: [],
    updatedAt: '2026-09-20T10:00:00Z',
    ...more,
  }) as unknown as Memory;

const harbor = { id: '7b1b0f0e-0000-4000-8000-000000000001', name: 'example/harbor' } as Project;
const soon = () => new Date(Date.now() + 5 * 3_600_000 + 60_000).toISOString();

const memories = () => [
  memory('harbor-trip', 'The owner sails from Port Alder every second Saturday.', {
    links: ['tea'],
  }),
  memory('tea', 'Prefers green tea, no sugar.', {
    links: ['harbor-trip'],
    projectIds: [harbor.id],
  }),
  memory('pr-review', 'Pull request 42 waits on review.', { expiresAt: soon() }),
];

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function show(api: Partial<GatewayApi> = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  actions.api = api as GatewayApi;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache profile={profile} slices={{ memories: memories(), projects: [harbor] }}>
        <MemoriesPage />
      </AgentCache>,
    ),
  );
}

const button = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );
const press = async (name: string) => {
  const found = button(name);
  if (!found) throw new Error(`no ${name}`);
  await act(async () => found.click());
};
/** The row that opens a memory, by its key. */
const row = (key: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('ul button')].find((item) =>
    item.textContent?.startsWith(key),
  );
const rows = (list: string) =>
  [...document.querySelectorAll(`ul[aria-label="${list}"] > li`)].map(
    (item) => item.textContent ?? '',
  );
const type = async (field: HTMLInputElement | null | undefined, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field?.dispatchEvent(new Event('input', { bubbles: true }));
  });

it('lists permanent and flash memories apart, and the tabs show one kind', async () => {
  await show();

  expect(rows('Permanent')).toHaveLength(2);
  expect(rows('Flash')).toEqual([expect.stringContaining('Expires in 5h')]);
  // Without a map: nothing drawn, no view to switch.
  expect(document.querySelector('svg[aria-label="Memory map"]')).toBeNull();

  await press('Flash');
  expect(rows('Permanent')).toEqual([]);
  expect(rows('Flash')).toHaveLength(1);

  await press('Permanent');
  expect(rows('Flash')).toEqual([]);
  expect(rows('Permanent')).toHaveLength(2);
});

it('searches text and pinned projects, and Enter opens the first match', async () => {
  await show();
  const field = document.querySelector<HTMLInputElement>('input[type="search"]');

  await type(field, 'harbor');
  // The key of one, and the project the other is pinned to.
  expect(rows('Permanent')).toHaveLength(2);
  expect(rows('Flash')).toEqual([]);

  await type(field, 'green tea');
  expect(rows('Permanent')).toEqual([expect.stringContaining('tea')]);

  await act(async () =>
    field?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(document.querySelector('h1')?.textContent).toBe('tea');
});

it('opens a memory on its own page, and goes back to the list', async () => {
  await show();
  await act(async () => row('harbor-trip')?.click());

  expect(document.querySelector('h1')?.textContent).toBe('harbor-trip');
  expect(document.body.textContent).toContain('Permanent memory');
  expect(document.body.textContent).toContain('Port Alder');
  expect(document.querySelector('dl[aria-label="Details"]')?.textContent).toContain('v2');
  expect(button('Unlink tea')).toBeDefined();

  // A linked memory opens in its place.
  await press('Open tea');
  expect(document.querySelector('h1')?.textContent).toBe('tea');

  await press('Memories');
  expect(rows('Permanent')).toHaveLength(2);
});

it('says when a flash memory ends', async () => {
  await show();
  await act(async () => row('pr-review')?.click());

  expect(document.body.textContent).toContain('Flash memory');
  expect(document.querySelector('dl[aria-label="Details"]')?.textContent).toContain('in 5h');
});

it('rewrites the text against the version on screen', async () => {
  const edit = vi.fn(async () => ({}));
  await show({ editMemory: edit } as unknown as Partial<GatewayApi>);
  await act(async () => row('tea')?.click());
  await press('Edit');

  const area = document.querySelector('textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      area,
      'Prefers jasmine tea.',
    );
    area?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await press('Save');

  expect(edit).toHaveBeenCalledWith(profile.id, 'tea', 'Prefers jasmine tea.', 2);
});

it('links, unlinks and unpins from the open memory', async () => {
  const link = vi.fn(async () => ({}));
  const unlink = vi.fn(async () => ({}));
  const pin = vi.fn(async () => ({}));
  await show({
    linkMemories: link,
    unlinkMemories: unlink,
    setMemoryProjects: pin,
  } as unknown as Partial<GatewayApi>);
  await act(async () => row('tea')?.click());

  await press('Unlink harbor-trip');
  expect(unlink).toHaveBeenCalledWith(profile.id, 'tea', 'harbor-trip');

  await press(`Remove ${harbor.name}`);
  expect(pin).toHaveBeenCalledWith(profile.id, 'tea', []);
});

it('forgets a memory only once the owner confirms it', async () => {
  const forget = vi.fn(async () => ({}));
  await show({ forget } as unknown as Partial<GatewayApi>);
  await act(async () => row('harbor-trip')?.click());

  await press('More');
  await press('Forget');
  const confirm = button('Forget memory') as HTMLButtonElement | undefined;
  expect(confirm?.disabled).toBe(true);
  expect(forget).not.toHaveBeenCalled();

  await type(confirm?.closest('[role="dialog"]')?.querySelector('input'), 'forget');
  await act(async () => confirm?.click());

  expect(forget).toHaveBeenCalledWith(profile.id, 'harbor-trip');
});
