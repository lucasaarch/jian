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

  await act(async () => view.button('Actions for concise')?.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent === 'Remove')
      ?.click(),
  );
  const confirm = view.button('Remove skill') as HTMLButtonElement | undefined;
  expect(confirm?.disabled).toBe(true);

  await view.type(confirm?.closest('[role="dialog"]')?.querySelector('input'), 'concise');
  await act(async () => confirm?.click());

  expect(updateProfile).toHaveBeenCalledWith(profile.id, {
    expectedVersion: profile.version,
    skills: [],
  });
});

const skill = (name: string, description: string) =>
  ({ name, description, instructions: `# ${name}`, enabled: true }) as BuiltinSkill;
const shownNames = () =>
  [...document.querySelectorAll('article h3')].map((item) => item.textContent);

it('finds a skill by what it says, accents and case aside', async () => {
  const view = await render({
    builtinSkills: async () => [
      skill('schedules', 'Do something later, once or on a repetition.'),
      skill('web-research', 'Search the web and read public pages, citing each résumé.'),
      skill('ssh-keys', 'Keys for Git over SSH, shared by every agent.'),
    ],
  });
  expect(shownNames()).toEqual(['concise', 'schedules', 'web-research', 'ssh-keys']);

  await view.type(
    document.querySelector<HTMLInputElement>('[aria-label="Search skills"]'),
    'RESUME web',
  );

  expect(shownNames()).toEqual(['web-research']);

  await view.type(document.querySelector<HTMLInputElement>('[aria-label="Search skills"]'), 'zzz');
  expect(document.body.textContent).toContain('No skill matches.');
});

it('narrows the cards by where the skills came from', async () => {
  const view = await render({});
  const choose = async (label: string) => {
    await act(async () => view.button('Show skills')?.click());
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((item) => item.textContent === label)
        ?.click(),
    );
  };

  await choose('Built-in');
  expect(shownNames()).toEqual(['web-research']);

  // The fixture's own skill carries an address: it was copied, not written here.
  await choose('Imported');
  expect(shownNames()).toEqual(['concise']);

  await choose('Written here');
  expect(shownNames()).toEqual([]);
});

it('opens a skill rendered as Markdown, and goes back to the cards', async () => {
  const view = await render({
    builtinSkills: async () => [
      { ...research, instructions: '# Find it\n\nUse **the web** first.\n\n- one\n- two' },
    ],
  });

  await act(async () => view.button('Read web-research')?.click());

  const reading = document.querySelector('section[aria-label="web-research"]');
  // The page's own title is an h3 as well; the heading written in the skill is inside `.markdown`.
  expect(reading?.querySelector('.markdown h3')?.textContent).toBe('Find it');
  expect(reading?.querySelector('strong')?.textContent).toBe('the web');
  expect(reading?.querySelectorAll('li')).toHaveLength(2);
  // The raw syntax is not what is read.
  expect(reading?.textContent).not.toContain('**');

  await act(async () => view.button('Back to skills')?.click());
  expect(shownNames()).toEqual(['concise', 'web-research']);
});
