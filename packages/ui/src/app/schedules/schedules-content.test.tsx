import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi, Schedule } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { AgentCache, agentClient } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { SchedulesContent } from './schedules-content';

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

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function render(api: Record<string, unknown>) {
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
  client.setQueryData(keys.schedules(profile.id), [summary]);
  client.setQueryData(keys.settings, { timeZone: 'UTC', timeZoneSource: 'setting' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache profile={profile} client={client}>
        <SchedulesContent />
      </AgentCache>,
    ),
  );
  // Inside the open dialog when one is open: the page behind it has buttons of the same name.
  const button = (name: string, within: ParentNode = document) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
    );
  const type = (input: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string) =>
    act(async () => {
      const prototype =
        input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(prototype.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  return { button, type };
}

const lastDialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1);

it('removes a schedule only once its name is typed', async () => {
  const deleteSchedule = vi.fn(async () => undefined);
  const view = await render({ deleteSchedule });

  await act(async () => view.button('Configure Morning summary')?.click());
  await act(async () => view.button('Remove', lastDialog())?.click());
  const confirm = view.button('Remove schedule', lastDialog());
  expect(confirm?.disabled).toBe(true);

  await view.type(lastDialog()?.querySelector<HTMLInputElement>('form input'), 'Morning summary');
  await act(async () => confirm?.click());

  expect(deleteSchedule).toHaveBeenCalledWith(profile.id, summary.id);
});

it('pauses at once, and switches back on when the gateway refuses', async () => {
  let refuse!: (reason: Error) => void;
  const updateSchedule = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
  );
  await render({ updateSchedule });
  const toggle = () => document.querySelector<HTMLElement>('[role="switch"]');

  await act(async () => toggle()?.click());
  // Pressed, not yet answered: it already shows what was asked.
  expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  expect(document.body.textContent).toContain('Paused');
  expect(updateSchedule).toHaveBeenCalledWith(profile.id, summary.id, { enabled: false });

  await act(async () => refuse(new Error('The gateway is unreachable.')));
  expect(toggle()?.getAttribute('aria-checked')).toBe('true');
});

it('creates a repeating schedule with the time written as its recurrence', async () => {
  const createSchedule = vi.fn(async () => ({}));
  const view = await render({ createSchedule });

  await act(async () => view.button('Add')?.click());
  const dialog = lastDialog();
  await view.type(dialog?.querySelector('input'), 'Evening check');
  await view.type(dialog?.querySelector('textarea'), 'Tell me what is still open today.');
  await act(async () => view.button('Repeat', dialog)?.click());
  // The time is picked from the hour and minute lists the field opens.
  const at = [...(dialog?.querySelectorAll('label') ?? [])].find(
    (label) => label.textContent === 'At',
  );
  await act(async () => document.getElementById(at?.htmlFor ?? '')?.click());
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Hour 18"]')?.click());
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Minute 30"]')?.click());
  // A new chat each time is what it runs in until told otherwise, and that says how it will run.
  expect(dialog?.textContent).toContain('Each run opens a new chat on Auto');
  await act(async () => view.button('Create', dialog)?.click());

  expect(createSchedule).toHaveBeenCalledWith(profile.id, {
    name: 'Evening check',
    instruction: 'Tell me what is still open today.',
    sessionId: null,
    model: null,
    timeZone: 'UTC',
    enabled: true,
    cron: '30 18 * * *',
  });
});
