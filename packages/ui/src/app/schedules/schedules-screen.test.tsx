import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { scheduleActions } from '../../components/schedules/list';
import type { GatewayApi, Schedule } from '../../lib/api';
import { schedulesPath } from '../../lib/navigation';
import { keys } from '../../lib/query/keys';
import { memoryNavigation } from '../../platform/navigation';
import { AgentCache, agentClient } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { SchedulesScreen } from './schedules-screen';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const actions = vi.hoisted(() => ({ api: {} as GatewayApi }));
vi.mock('../../lib/workspace', () => ({
  useActions: () => ({
    api: actions.api,
    // As the panel's own: false when the action failed, and nothing reloaded.
    mutate: (action: () => Promise<unknown>) =>
      action().then(
        () => true,
        () => false,
      ),
    busy: false,
  }),
}));

const summary = {
  id: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  profileId: profile.id,
  name: 'Morning summary',
  instruction: 'Send me a summary of what is due today.',
  sessionId: null,
  cron: '0 8 * * *',
  timeZone: 'UTC',
  enabled: true,
  nextRunAt: '2026-11-01T08:00:00Z',
  createdBy: 'owner',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
} as Schedule;

const { cron: _cron, ...once } = summary;
const dentist = {
  ...once,
  id: '4a3b2c1d-6e5f-4a07-9b8a-1d0c2e3f4a5b',
  name: 'Dentist',
  instruction: 'Remind me of the dentist.',
  at: '2026-11-03T14:00:00Z',
} as Schedule;

const page = schedulesPath(profile.id);
const opened = (id: string) => `${page}?schedule=${id}`;

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function render(api: Record<string, unknown>, address = page) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  actions.api = { scheduleHistory: async () => [], ...api } as unknown as GatewayApi;
  const client = agentClient({
    profile,
    slices: {
      sessions: [],
      contacts: [],
      // What the model menu of a new chat each time reads; no provider, so it starts empty.
      providers: [],
      providerModels: {},
      modelDefaults: { conversation: null },
    } as never,
  });
  client.setQueryData(keys.schedules(profile.id), [summary, dentist]);
  client.setQueryData(keys.settings, { timeZone: 'UTC', timeZoneSource: 'setting' });
  // Where the page is, which the agent's cache alone leaves at the agent.
  memoryNavigation.go(address);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache profile={profile} client={client}>
        <SchedulesScreen profileId={profile.id} />
      </AgentCache>,
    ),
  );
  // Inside the open dialog when one is open: the page behind it has buttons of the same name.
  const button = (name: string, within: ParentNode = document) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
    );
  const row = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('li > button')].find((item) =>
      item.textContent?.includes(name),
    );
  const type = (input: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string) =>
    act(async () => {
      const prototype =
        input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(prototype.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  return { button, row, type };
}

const heading = () => document.querySelector('h1')?.textContent;
const dialog = () => document.querySelector('[role="dialog"]') ?? undefined;
const sections = () =>
  [...document.querySelectorAll('section[aria-label] > header h2')].map((item) => item.textContent);

it('lists the schedules on a page in the chat’s place, and opens one in full on it', async () => {
  const view = await render({});

  expect(heading()).toBe('Schedules');
  expect(sections()).toEqual(['Repeating', 'Once']);
  expect(view.row('Morning summary')?.textContent).toContain('Every day');

  await act(async () => view.row('Morning summary')?.click());
  expect(memoryNavigation.current()).toBe(opened(summary.id));
  expect(heading()).toBe('Morning summary');
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(summary.instruction);

  // Its heading's way back is the browser's, one step back to the list.
  await act(async () => view.button('Schedules')?.click());
  expect(memoryNavigation.current()).toBe(page);
  expect(heading()).toBe('Schedules');
});

it('keeps the one open in the address, so the browser’s back and a link both work', async () => {
  const view = await render({}, opened(dentist.id));
  expect(heading()).toBe('Dentist');

  // Opened by the address, nothing of the page is behind it: back is to the list in its place.
  await act(async () => view.button('Schedules')?.click());
  expect(memoryNavigation.current()).toBe(page);

  await act(async () => view.row('Dentist')?.click());
  await act(async () => memoryNavigation.back());
  expect(heading()).toBe('Schedules');
});

it('searches the list from its toolbar', async () => {
  const view = await render({});

  await view.type(document.querySelector<HTMLInputElement>('input[type="search"], input'), 'dent');
  expect(view.row('Dentist')).toBeDefined();
  expect(view.row('Morning summary')).toBeUndefined();

  await view.type(document.querySelector<HTMLInputElement>('input'), 'nothing like it');
  expect(document.body.textContent).toContain('No schedule matches.');
});

it('removes a schedule only once its name is typed, and goes back to the list', async () => {
  const deleteSchedule = vi.fn(async () => undefined);
  const view = await render({ deleteSchedule }, opened(summary.id));

  await act(async () => view.button('Remove')?.click());
  const confirm = view.button('Remove schedule', dialog());
  expect(confirm?.disabled).toBe(true);

  await view.type(dialog()?.querySelector<HTMLInputElement>('form input'), 'Morning summary');
  await act(async () => confirm?.click());

  expect(deleteSchedule).toHaveBeenCalledWith(profile.id, summary.id);
  expect(memoryNavigation.current()).toBe(page);
});

it('pauses at once, and switches back on when the gateway refuses', async () => {
  let refuse!: (reason: Error) => void;
  const updateSchedule = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
  );
  await render({ updateSchedule }, opened(summary.id));
  const toggle = () => document.querySelector<HTMLElement>('[role="switch"]');

  await act(async () => toggle()?.click());
  // Pressed, not yet answered: it already shows what was asked.
  expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  expect(document.body.textContent).toContain('Paused');
  expect(updateSchedule).toHaveBeenCalledWith(profile.id, summary.id, { enabled: false });

  await act(async () => refuse(new Error('The gateway is unreachable.')));
  expect(toggle()?.getAttribute('aria-checked')).toBe('true');
});

it('creates a repeating schedule from the toolbar, with the time written as its recurrence', async () => {
  const createSchedule = vi.fn(async () => ({ id: 'made' }));
  const view = await render({ createSchedule });

  await act(async () => view.button('New schedule')?.click());
  expect(memoryNavigation.current()).toBe(opened('new'));
  expect(heading()).toBe('New schedule');
  await view.type(
    document.querySelector<HTMLInputElement>('input[placeholder="Morning summary"]'),
    'Evening check',
  );
  await view.type(document.querySelector('textarea'), 'Tell me what is still open today.');
  await act(async () => view.button('Repeat')?.click());
  // The time is picked from the hour and minute lists the field opens.
  const at = [...document.querySelectorAll('label')].find((label) => label.textContent === 'At');
  await act(async () => document.getElementById(at?.htmlFor ?? '')?.click());
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Hour 18"]')?.click());
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Minute 30"]')?.click());
  // A new chat each time is what it runs in until told otherwise, and that says how it will run.
  expect(document.body.textContent).toContain('Each run opens a new chat on Auto');
  await act(async () => view.button('Create')?.click());

  expect(createSchedule).toHaveBeenCalledWith(profile.id, {
    name: 'Evening check',
    instruction: 'Tell me what is still open today.',
    sessionId: null,
    model: null,
    timeZone: 'UTC',
    enabled: true,
    cron: '30 18 * * *',
  });
  // Made, it is found in the list the page goes back to.
  expect(memoryNavigation.current()).toBe(page);
});

it('saves a changed model on a schedule that exists', async () => {
  const model = { providerId: 'provider', modelId: 'atlas-large', reasoningEffort: 'high' };
  const updateSchedule = vi.fn(async () => ({}));
  const act2 = scheduleActions(
    {
      api: { updateSchedule } as unknown as GatewayApi,
      mutate: async (work: () => Promise<unknown>) => {
        await work();
        return true;
      },
    } as never,
    profile.id,
  );

  await act2.save(summary, {
    name: summary.name,
    instruction: summary.instruction,
    sessionId: null,
    model,
    timeZone: 'UTC',
    enabled: true,
    cron: '0 8 * * *',
  } as never);

  expect(updateSchedule).toHaveBeenCalledWith(
    profile.id,
    summary.id,
    expect.objectContaining({ model }),
  );
});
