import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CommandSecret, GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { AgentCache, agentClient } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { CommandSecretsPage } from './command-secrets-page';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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

// Synthetic, and never in anything the gateway returns.
const VALUE = 'sk_synthetic_word_timings_42';
const timings: CommandSecret = {
  name: 'ASSEMBLYAI_API_KEY',
  description: 'Word timings',
  profileIds: [profile.id],
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  lastUsedAt: null,
};

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function render(api: Record<string, unknown>, secrets: CommandSecret[] = []) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  actions.api = api as unknown as GatewayApi;
  const client = agentClient({ profile });
  client.setQueryData(keys.commandSecrets(profile.id), secrets);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache profile={profile} client={client}>
        <CommandSecretsPage />
      </AgentCache>,
    ),
  );
  return {
    host,
    button: (name: string, within: ParentNode = document) =>
      [...within.querySelectorAll('button')].find(
        (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
      ),
    type: (input: HTMLInputElement | null | undefined, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          value,
        );
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      }),
  };
}

const lastDialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1);

it('adds a secret by name and value, and shows only its name afterwards', async () => {
  const createCommandSecret = vi.fn(async () => timings);
  const { host, button, type } = await render({ createCommandSecret });
  expect(host.textContent).toContain('No secrets yet');

  await act(async () => button('Add')?.click());
  const dialog = lastDialog();
  const [name, value] = [...(dialog?.querySelectorAll('input') ?? [])];
  expect(value?.type).toBe('password');
  await type(name, 'assemblyai-api-key');
  await type(value, VALUE);
  await act(async () => button('Add secret', dialog)?.click());

  expect(createCommandSecret).toHaveBeenCalledWith(profile.id, {
    name: 'ASSEMBLYAI_API_KEY',
    value: VALUE,
  });
  expect(host.textContent).toContain('ASSEMBLYAI_API_KEY');
  expect(document.body.innerHTML).not.toContain(VALUE);
});

it('refuses a name a command already has before sending it', async () => {
  const createCommandSecret = vi.fn();
  const { button, type } = await render({ createCommandSecret });

  await act(async () => button('Add')?.click());
  const dialog = lastDialog();
  const [name, value] = [...(dialog?.querySelectorAll('input') ?? [])];
  await type(name, 'PATH');
  await type(value, VALUE);

  expect(button('Add secret', dialog)?.disabled).toBe(true);
  expect(dialog?.textContent).toContain('one of Jian’s own');
});

it('replaces a value only when one is typed, and deletes once the name is typed', async () => {
  const updateCommandSecret = vi.fn(async () => timings);
  const deleteCommandSecret = vi.fn(async () => ({ name: timings.name }));
  const { host, button, type } = await render({ updateCommandSecret, deleteCommandSecret }, [
    timings,
  ]);

  await act(async () => button('Edit ASSEMBLYAI_API_KEY')?.click());
  let dialog = lastDialog();
  await act(async () => button('Save', dialog)?.click());
  expect(updateCommandSecret).toHaveBeenLastCalledWith(profile.id, timings.name, {
    description: 'Word timings',
    profileIds: [profile.id],
  });

  await act(async () => button('Edit ASSEMBLYAI_API_KEY')?.click());
  dialog = lastDialog();
  await type(dialog?.querySelector<HTMLInputElement>('input[type="password"]'), `${VALUE}-new`);
  await act(async () => button('Save', dialog)?.click());
  expect(updateCommandSecret).toHaveBeenLastCalledWith(profile.id, timings.name, {
    description: 'Word timings',
    profileIds: [profile.id],
    value: `${VALUE}-new`,
  });

  await act(async () => button('Delete ASSEMBLYAI_API_KEY')?.click());
  dialog = lastDialog();
  const confirm = button('Delete secret', dialog);
  expect(confirm?.disabled).toBe(true);
  await type(dialog?.querySelector('input'), timings.name);
  await act(async () => confirm?.click());

  expect(deleteCommandSecret).toHaveBeenCalledWith(profile.id, timings.name);
  expect(host.textContent).not.toContain('ASSEMBLYAI_API_KEY');
});
