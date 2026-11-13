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

const memory = (key: string, content: string, links: string[] = [], projectIds: string[] = []) =>
  ({
    key,
    content,
    version: 2,
    links,
    projectIds,
    updatedAt: '2026-09-20T10:00:00Z',
  }) as unknown as Memory;

const harbor = { id: '7b1b0f0e-0000-4000-8000-000000000001', name: 'example/harbor' } as Project;

const memories = [
  memory('harbor-trip', 'The owner sails from Port Alder every second Saturday.', ['tea']),
  memory('tea', 'Prefers green tea, no sugar.', ['harbor-trip'], [harbor.id]),
  memory('garden', 'Tomatoes need staking in June.'),
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
      <AgentCache profile={profile} slices={{ memories, projects: [harbor] }}>
        <MemoriesPage />
      </AgentCache>,
    ),
  );
}

const nodes = () => [...document.querySelectorAll('svg [role="button"]')];
const node = (key: string) => nodes().find((item) => item.getAttribute('aria-label') === key);
// An SVG element has no `click()` of its own.
const press = (key: string, shiftKey = false) =>
  act(async () => {
    node(key)?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }));
  });
const button = (name: string) =>
  [...document.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );
const type = async (field: HTMLInputElement | null | undefined, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field?.dispatchEvent(new Event('input', { bubbles: true }));
  });

it('draws a node for each memory and one line for each link', async () => {
  await show();

  expect(nodes().map((item) => item.getAttribute('aria-label'))).toEqual(
    expect.arrayContaining(['harbor-trip', 'tea', 'garden']),
  );
  expect(nodes()).toHaveLength(3);
  // The link is on both memories, and is one line.
  expect(document.querySelectorAll('svg[aria-label="Memory map"] line')).toHaveLength(1);
});

it('keeps the nodes in place when the view is changed and changed back', async () => {
  await show();
  const before = [...document.querySelectorAll('svg[aria-label="Memory map"] circle')].map(
    (item) => item.outerHTML,
  );
  await act(async () => button('List')?.click());
  await act(async () => button('Map')?.click());

  expect(
    [...document.querySelectorAll('svg[aria-label="Memory map"] circle')].map(
      (item) => item.outerHTML,
    ),
  ).toEqual(before);
});

it('searches the map and the list, and Enter opens the first match', async () => {
  await show();
  const field = document.querySelector<HTMLInputElement>('input[type="search"]');

  await type(field, 'tomato');

  expect(node('garden')?.getAttribute('class')).not.toContain('opacity-30');
  expect(node('tea')?.getAttribute('class')).toContain('opacity-30');

  await act(async () =>
    field?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(document.querySelector('textarea')?.value).toBe('Tomatoes need staking in June.');

  await act(async () => button('List')?.click());
  expect(document.querySelectorAll('ul[aria-label="Memories"] > li')).toHaveLength(1);
});

it('lets the keyboard reach every node and open one with Enter', async () => {
  await show();

  expect(nodes().every((item) => item.getAttribute('tabindex') === '0')).toBe(true);
  await act(async () =>
    node('garden')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(document.querySelector('aside')?.textContent).toContain('garden');
});

it('opens a memory beside the map with its text, version and links', async () => {
  await show();
  await press('harbor-trip');

  const panel = document.querySelector('aside');
  expect(panel?.textContent).toContain('harbor-trip');
  expect(panel?.textContent).toContain('v2');
  expect(panel?.querySelector('textarea')?.value).toContain('Port Alder');
  expect(panel?.querySelector('[aria-label="Unlink tea"]')).toBeTruthy();
});

it('links and unlinks from the open memory', async () => {
  const link = vi.fn(async () => ({}));
  const unlink = vi.fn(async () => ({}));
  await show({ linkMemories: link, unlinkMemories: unlink } as unknown as Partial<GatewayApi>);
  await press('garden');

  // Shift-click on another node links the pair…
  await press('tea', true);
  expect(link).toHaveBeenCalledWith(profile.id, 'garden', 'tea');

  // …and the chip's remove takes a link away.
  await press('harbor-trip');
  await act(async () => button('Unlink tea')?.click());
  expect(unlink).toHaveBeenCalledWith(profile.id, 'harbor-trip', 'tea');
});

it('pins a memory to a project and takes the pin away', async () => {
  const pin = vi.fn(async () => ({}));
  await show({ setMemoryProjects: pin } as unknown as Partial<GatewayApi>);
  await press('tea');
  await act(async () => button(`Remove ${harbor.name}`)?.click());

  expect(pin).toHaveBeenCalledWith(profile.id, 'tea', []);
});

it('marks the memories of a chosen project on the map', async () => {
  await show();
  await act(async () => button('Project')?.click());
  const option = [...document.querySelectorAll('[role="option"]')].find((item) =>
    item.textContent?.includes(harbor.name),
  );
  await act(async () => (option as HTMLElement | undefined)?.click());

  expect(node('tea')?.getAttribute('class')).not.toContain('opacity-30');
  expect(node('garden')?.getAttribute('class')).toContain('opacity-30');
});

it('forgets a memory only once the owner confirms it', async () => {
  const forget = vi.fn(async () => ({}));
  await show({ forget } as unknown as Partial<GatewayApi>);

  await press('harbor-trip');
  await act(async () => button('Forget')?.click());
  const confirm = button('Forget memory') as HTMLButtonElement | undefined;
  expect(confirm?.disabled).toBe(true);
  expect(forget).not.toHaveBeenCalled();

  await type(confirm?.closest('[role="dialog"]')?.querySelector('input'), 'forget');
  await act(async () => confirm?.click());

  expect(forget).toHaveBeenCalledWith(profile.id, 'harbor-trip');
});
