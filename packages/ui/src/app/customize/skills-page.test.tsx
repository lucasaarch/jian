import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { BuiltinSkill, GatewayApi } from '../../lib/api';
import { AgentCache } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { SkillsPage } from './skills-page';

const actions = vi.hoisted(() => ({ api: {} as GatewayApi }));
vi.mock('../../lib/workspace', () => ({
  useActions: () => ({
    api: actions.api,
    // As the panel's own: false when the action failed.
    mutate: (action: () => Promise<unknown>) =>
      action().then(
        () => true,
        () => false,
      ),
    busy: false,
  }),
}));

const research = {
  name: 'web-research',
  description: 'Search the web and read public pages.',
  instructions: '# Web research',
  enabled: true,
} as BuiltinSkill;

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function render(api: Record<string, unknown>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  actions.api = { builtinSkills: async () => [research], ...api } as unknown as GatewayApi;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache profile={profile}>
        <SkillsPage />
      </AgentCache>,
    ),
  );
  // The built-in list arrives after the first render.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const button = (name: string) =>
    [...document.querySelectorAll('button')].find(
      (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
    );
  const type = (input: HTMLInputElement | null | undefined, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  return { button, type };
}

it('switches a built-in skill at once, and puts it back when the gateway refuses', async () => {
  let refuse: (reason: Error) => void = () => {};
  const updateProfile = vi.fn(
    () =>
      new Promise((_, reject) => {
        refuse = reject;
      }),
  );
  await render({ updateProfile });
  const toggle = () => document.querySelector('[role="switch"][aria-label="web-research"]');
  expect(toggle()?.getAttribute('aria-checked')).toBe('true');

  await act(async () => (toggle() as HTMLElement | null)?.click());

  // Shown off while the gateway has not answered.
  expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  expect(updateProfile).toHaveBeenCalledWith(profile.id, {
    expectedVersion: profile.version,
    disabledSkills: ['web-research'],
  });

  await act(async () => refuse(new Error('The profile changed meanwhile.')));
  expect(toggle()?.getAttribute('aria-checked')).toBe('true');
});

it('removes a skill of its own only once its name is typed', async () => {
  const updateProfile = vi.fn(async () => profile);
  const view = await render({ updateProfile });

  await act(async () => view.button('Configure concise')?.click());
  await act(async () => view.button('Remove')?.click());
  const confirm = view.button('Remove skill') as HTMLButtonElement | undefined;
  expect(confirm?.disabled).toBe(true);

  await view.type(confirm?.closest('form')?.querySelector('input'), 'concise');
  await act(async () => confirm?.click());

  expect(updateProfile).toHaveBeenCalledWith(profile.id, {
    expectedVersion: profile.version,
    skills: [],
  });
});

it('finds a built-in skill by what it says, accents and case aside', async () => {
  const skill = (name: string, description: string) =>
    ({ name, description, instructions: `# ${name}`, enabled: true }) as BuiltinSkill;
  const view = await render({
    builtinSkills: async () => [
      skill('schedules', 'Do something later, once or on a repetition.'),
      skill('web-research', 'Search the web and read public pages, citing each résumé.'),
      skill('ssh-keys', 'Keys for Git over SSH, shared by every agent.'),
    ],
  });
  const shown = () =>
    [...document.querySelectorAll('[role="switch"]')].map((item) =>
      item.getAttribute('aria-label'),
    );
  expect(shown()).toEqual(['schedules', 'web-research', 'ssh-keys']);

  await view.type(
    document.querySelector<HTMLInputElement>('[aria-label="Search built-in skills"]'),
    'RESUME web',
  );

  expect(shown()).toEqual(['web-research']);
});
