import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi, Profile, Secret } from '../../lib/api';
import { date } from '../../lib/format';
import { keys } from '../../lib/query/keys';
import { AgentCache, agentClient } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { SecretsPage } from './secrets-page';

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

const atlas: Profile = { ...profile, id: '1f0e2d3c-4b5a-4968-8776-655443322110', name: 'Atlas' };
const vega: Profile = { ...profile, id: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', name: 'Vega' };

// Synthetic, and never in anything the gateway returns.
const PASSWORD = 'synthetic-mail-password-42';
const mail: Secret = {
  id: '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a',
  title: 'Mail account',
  description: 'The shared support inbox',
  sites: ['https://mail.example.com'],
  fields: [
    { label: 'Login', envName: 'MAIL_LOGIN', sensitive: false, value: 'support@example.com' },
    { label: 'Password', envName: 'MAIL_PASSWORD', sensitive: true, value: null },
  ],
  profileIds: [profile.id, vega.id, atlas.id],
  grants: [
    { profileId: profile.id, grantedByProfileId: null, grantedAt: '2026-11-01T10:00:00Z' },
    { profileId: vega.id, grantedByProfileId: vega.id, grantedAt: '2026-11-01T10:00:00Z' },
    { profileId: atlas.id, grantedByProfileId: vega.id, grantedAt: '2026-11-02T09:30:00Z' },
  ],
  createdByProfileId: vega.id,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-02T09:30:00Z',
  lastUsedAt: null,
};

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function render(api: Record<string, unknown>, secrets: Secret[] = []) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  actions.api = api as unknown as GatewayApi;
  const client = agentClient({ profile, profiles: [profile, atlas, vega] });
  client.setQueryData(keys.secrets(profile.id), secrets);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache profile={profile} client={client}>
        <SecretsPage />
      </AgentCache>,
    ),
  );
  return { host };
}

const lastDialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1);

const button = (name: string, within: ParentNode = document) =>
  [...within.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );

const click = (target: HTMLElement | undefined | null) => act(async () => target?.click());

/** Every input a visible label of these words names, in order. */
const inputs = (within: ParentNode | undefined, label: string) =>
  [...(within?.querySelectorAll('label') ?? [])]
    .filter((item) => item.textContent?.trim() === label)
    .map((item) => document.getElementById(item.htmlFor) as HTMLInputElement);

const type = (input: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string) =>
  act(async () => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });

it('lists each Secret with its fields, who made it and who shares it', async () => {
  const { host } = await render({}, [mail]);

  const row = button('Edit Mail account')?.closest('.py-3');
  expect(row?.textContent).toContain('Mail account');
  expect(row?.textContent).toContain('Login, Password');
  expect(row?.textContent).toContain('Made by Vega');
  expect(row?.textContent).toContain('Shared with Vega, Atlas');
  // A value, even one that is not sensitive, is for the dialog, not the list.
  expect(host.innerHTML).not.toContain('support@example.com');
});

it('adds a Secret with a login and a password', async () => {
  const createSecret = vi.fn(async () => mail);
  const { host } = await render({ createSecret });
  expect(host.textContent).toContain('No secrets yet');

  await click(button('Add'));
  const dialog = lastDialog();
  await type(inputs(dialog, 'Title')[0], 'Mail account');
  await type(inputs(dialog, 'Label')[0], 'Login');
  await type(inputs(dialog, 'Variable')[0], 'mail-login');
  // A new field is sensitive until it is said otherwise; a login is not.
  await click(dialog?.querySelectorAll<HTMLElement>('[role="switch"]')[0]);
  await type(inputs(dialog, 'Value')[0], 'support@example.com');
  expect(inputs(dialog, 'Value')[0]?.type).toBe('text');

  await click(button('Add a field', dialog));
  await type(inputs(dialog, 'Label')[1], 'Password');
  await type(inputs(dialog, 'Variable')[1], 'MAIL_PASSWORD');
  const password = inputs(dialog, 'Value')[1];
  expect(password?.type).toBe('password');
  await type(password, PASSWORD);
  await click(button('Add secret', dialog));

  expect(createSecret).toHaveBeenCalledWith(profile.id, {
    title: 'Mail account',
    fields: [
      { label: 'Login', envName: 'MAIL_LOGIN', sensitive: false, value: 'support@example.com' },
      { label: 'Password', envName: 'MAIL_PASSWORD', sensitive: true, value: PASSWORD },
    ],
  });
  expect(host.textContent).toContain('Mail account');
  expect(document.body.innerHTML).not.toContain(PASSWORD);
});

it('shows why a site is refused on its row, and sends only its origin', async () => {
  const createSecret = vi.fn(async () => mail);
  await render({ createSecret });

  await click(button('Add'));
  const dialog = lastDialog();
  await type(inputs(dialog, 'Title')[0], 'Mail account');
  await type(inputs(dialog, 'Label')[0], 'Password');
  await type(inputs(dialog, 'Variable')[0], 'MAIL_PASSWORD');
  await type(inputs(dialog, 'Value')[0], PASSWORD);
  await click(button('Add a site', dialog));
  const site = dialog?.querySelector<HTMLInputElement>('input[type="url"]');
  await type(site, 'http://mail.example.com');

  expect(site?.closest('li')?.textContent).toContain('Use an https address');
  expect(button('Add secret', dialog)?.disabled).toBe(true);

  await type(site, 'https://mail.example.com/login?next=1');
  await click(button('Add secret', dialog));
  expect(createSecret).toHaveBeenCalledWith(
    profile.id,
    expect.objectContaining({ sites: ['https://mail.example.com'] }),
  );
});

it('keeps a sensitive value when it is left empty on edit', async () => {
  const updateSecret = vi.fn(async () => mail);
  await render({ updateSecret }, [mail]);

  await click(button('Edit Mail account'));
  const dialog = lastDialog();
  const [login, password] = inputs(dialog, 'Value');
  expect(login?.value).toBe('support@example.com');
  expect(password?.value).toBe('');
  await click(button('Save', dialog));

  expect(updateSecret).toHaveBeenCalledWith(profile.id, mail.id, {
    title: 'Mail account',
    description: 'The shared support inbox',
    sites: ['https://mail.example.com'],
    fields: [
      { label: 'Login', envName: 'MAIL_LOGIN', sensitive: false, value: 'support@example.com' },
      { label: 'Password', envName: 'MAIL_PASSWORD', sensitive: true },
    ],
    profileIds: [profile.id, vega.id, atlas.id],
  });
});

it('shows who shared it with whom', async () => {
  await render({}, [mail]);

  await click(button('Edit Mail account'));
  const dialog = lastDialog();

  expect(dialog?.textContent).toContain(
    `Shared with Atlas by Vega · ${date('2026-11-02T09:30:00Z')}`,
  );
  // Vega made it, and having it is not a share.
  expect(dialog?.textContent).not.toContain('Shared with Vega');
});

it('deletes once the title is typed', async () => {
  const deleteSecret = vi.fn(async () => ({ id: mail.id }));
  const { host } = await render({ deleteSecret }, [mail]);

  await click(button('Delete Mail account'));
  const dialog = lastDialog();
  const confirm = button('Delete secret', dialog);
  expect(confirm?.disabled).toBe(true);
  await type(dialog?.querySelector('input'), mail.title);
  await click(confirm);

  expect(deleteSecret).toHaveBeenCalledWith(profile.id, mail.id);
  expect(host.textContent).not.toContain('Mail account');
});
