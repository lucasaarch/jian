import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BuiltinSkill, GatewayApi } from '../../lib/api';
import { librarySkills, profile } from '../../test/fixtures';
import { PluginsScreen } from './plugins-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const address = vi.hoisted(() => ({ query: '', replace: vi.fn() }));
vi.mock('../../platform/navigation', () => ({
  usePathname: () => '/agents/a1/plugins',
  useRouter: () => ({ replace: address.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(address.query),
}));
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
  notifyError: vi.fn(),
}));
// No connector of the gateway's own, so a row here is a skill or one of the catalog's apps.
vi.mock('../../lib/query/client', () => ({
  panelApi: () => ({
    githubIntegration: async () => ({ configured: false, accounts: [] }),
    xIntegration: async () => ({ configured: false, accounts: [] }),
    mcpServers: async () => [],
    profiles: async () => [profile],
  }),
}));

const skill = (name: string, description: string, instructions = `# ${name}`) =>
  ({ name, description, instructions, enabled: true }) as BuiltinSkill;
const research = skill('web-research', 'Search the web and read public pages.');

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  address.query = 'tab=skills';
  address.replace.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

async function show(api: Record<string, unknown> = {}) {
  actions.api = {
    skills: async () => librarySkills,
    builtinSkills: async () => [research],
    ...api,
  } as unknown as GatewayApi;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <Suspense fallback={<p role="status">Loading</p>}>
          <PluginsScreen />
        </Suspense>
      </QueryClientProvider>,
    ),
  );
  // The agents, the connectors and both lists of skills arrive after the first render.
  await act(async () => {
    await vi.waitFor(() => expect(host.querySelector('[role="status"]')).toBeNull());
  });
}

/** A row's name: the first of the words a row cuts short. */
const nameOf = (item: Element) => item.querySelector('.truncate')?.textContent ?? '';
const rows = (section?: string) => [
  ...host.querySelectorAll(section ? `ul[aria-label="${section}"] li` : 'ul li'),
];
const names = (section?: string) => rows(section).map(nameOf);
const row = (name: string) => rows().find((item) => nameOf(item) === name);
const button = (name: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );
const press = async (name: string, within?: ParentNode) => {
  const found = button(name, within);
  if (!found) throw new Error(`no ${name}`);
  await act(async () => found.click());
};
/** Opens a skill from its row, as a click on it does, and gives back what opened. */
const open = async (name: string) => {
  const found = row(name)?.querySelector('button');
  if (!found) throw new Error(`no row ${name}`);
  await act(async () => found.click());
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error(`${name} did not open`);
  return dialog;
};
const type = (input: HTMLInputElement | null | undefined, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
const search = (text: string) =>
  type(host.querySelector<HTMLInputElement>('input[aria-label="Search plugins"]'), text);
const filterBy = async (label: string) => {
  const filter = button('Filter skills', host);
  if (!filter) throw new Error('no filter');
  await act(async () => {
    filter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    filter.click();
  });
  const option = await vi.waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent === label,
    );
    if (!found) throw new Error(`no option ${label}`);
    return found;
  });
  await act(async () => option.click());
};

it('says who made each skill, the library first and then what Jian ships', async () => {
  await show();

  expect(names('Library')).toEqual(['concise', 'standup-notes', 'trip-planning', 'invoice-check']);
  expect(names('Built-in')).toEqual(['web-research']);
  expect(row('concise')?.textContent).toContain('Skill · Imported from example/skills');
  expect(row('standup-notes')?.textContent).toContain('Skill · By you');
  expect(row('trip-planning')?.textContent).toContain(`Skill · By ${profile.name}`);
  // Its author is no longer among the agents.
  expect(row('invoice-check')?.textContent).toContain('Skill · By an agent');
  expect(row('web-research')?.textContent).toContain('Skill · By Jian');

  // Only what Jian ships is verified, and only what is switched off says how it stands.
  expect(row('web-research')?.querySelector('[aria-label="Verified"]')).not.toBeNull();
  expect(row('concise')?.querySelector('[aria-label="Verified"]')).toBeNull();
  expect(row('invoice-check')?.textContent).toContain('Off');
  expect(row('concise')?.textContent).not.toContain('Off');
});

it('opens the Skills tab an address names, and stops naming it once another is chosen', async () => {
  await show();
  expect(button('Filter skills', host)).toBeDefined();
  expect(button('Filter connectors', host)).toBeUndefined();

  await press('All', host);
  // Each kind's filter is on its own tab alone.
  expect(button('Filter skills', host)).toBeUndefined();
  expect(address.replace).toHaveBeenCalledWith('/agents/a1/plugins');
});

it('shows the first skills on All, the library before the built-in, and the rest behind Show all', async () => {
  address.query = '';
  await show({
    builtinSkills: async () =>
      Array.from({ length: 6 }, (_, index) => skill(`built-${index}`, 'Shipped with Jian.')),
  });

  expect(names('Skills')).toEqual([
    ...librarySkills.map((item) => item.name),
    'built-0',
    'built-1',
    'built-2',
    'built-3',
  ]);

  const section = host.querySelector('section[aria-label="Skills"]');
  if (!section) throw new Error('no Skills section');
  await press('Show all', section);

  expect(names('Built-in')).toHaveLength(6);
  expect(names('Library')).toHaveLength(librarySkills.length);
});

it('switches a skill for every agent at once, and puts it back when the gateway refuses', async () => {
  let refuse: (reason: Error) => void = () => {};
  const setSkillEnabled = vi.fn(
    () =>
      new Promise((_, reject) => {
        refuse = reject;
      }),
  );
  await show({ setSkillEnabled });
  const dialog = await open('web-research');
  const toggle = () => dialog.querySelector<HTMLElement>('[role="switch"]');
  expect(toggle()?.getAttribute('aria-checked')).toBe('true');

  await act(async () => toggle()?.click());

  // Shown off while the gateway has not answered, in the dialog and on the row under it.
  expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  expect(row('web-research')?.textContent).toContain('Off');
  expect(setSkillEnabled).toHaveBeenCalledWith('web-research', false);

  await act(async () => refuse(new Error('The gateway is unreachable.')));
  expect(toggle()?.getAttribute('aria-checked')).toBe('true');
  expect(row('web-research')?.textContent).not.toContain('Off');
});

it('switches a skill of the library the same way, whoever wrote it', async () => {
  const setSkillEnabled = vi.fn(async () => null);
  await show({ setSkillEnabled });
  const dialog = await open('invoice-check');
  expect(dialog.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');

  await act(async () => dialog.querySelector<HTMLElement>('[role="switch"]')?.click());

  expect(setSkillEnabled).toHaveBeenCalledWith('invoice-check', true);
});

it('deletes a skill of the library only once its name is typed', async () => {
  const deleteSkill = vi.fn(async () => null);
  await show({ deleteSkill });
  const dialog = await open('trip-planning');

  await press('Delete', dialog);
  const confirm = button('Delete skill') as HTMLButtonElement | undefined;
  expect(confirm?.disabled).toBe(true);
  expect(deleteSkill).not.toHaveBeenCalled();

  await type(confirm?.closest('[role="dialog"]')?.querySelector('input'), 'trip-planning');
  await act(async () => confirm?.click());

  expect(deleteSkill).toHaveBeenCalledWith('trip-planning');
});

/** The form that opened, once it is there. */
const opened = () =>
  vi.waitFor(() => {
    const found = document.querySelector<HTMLFormElement>('[role="dialog"] form');
    if (!found) throw new Error('no form');
    return found;
  });
/** The overlay draws a form's actions in its own foot, outside the form they submit. */
const submit = (form: HTMLFormElement) =>
  act(async () =>
    form
      .closest('[role="dialog"]')
      ?.querySelector<HTMLButtonElement>('button[type="submit"]')
      ?.click(),
  );

it('saves an edit to any skill of the library under the name it has', async () => {
  const updateSkill = vi.fn(async () => null);
  await show({ updateSkill });
  // An agent wrote this one; the owner edits it all the same.
  await press('Edit', await open('trip-planning'));

  const form = await opened();
  await type(form.querySelector<HTMLInputElement>('input[name="description"]'), 'Dates first.');
  await submit(form);

  expect(updateSkill).toHaveBeenCalledWith('trip-planning', {
    description: 'Dates first.',
    instructions: 'Ask for the dates before anything else.',
  });
});

it('reads a built-in skill as Markdown, with nothing to edit or delete', async () => {
  await show({
    builtinSkills: async () => [
      { ...research, instructions: '# Find it\n\nUse **the web** first.\n\n- one\n- two' },
    ],
  });

  const dialog = await open('web-research');

  expect(dialog.querySelector('[aria-label="Verified"]')).not.toBeNull();
  expect(dialog.textContent).toContain('Skill · By Jian');
  // The skill's name is the dialog's h2; the heading written in the skill is inside `.markdown`.
  expect(dialog.querySelector('.markdown h3')?.textContent).toBe('Find it');
  expect(dialog.querySelector('strong')?.textContent).toBe('the web');
  expect(dialog.querySelectorAll('.markdown li')).toHaveLength(2);
  // The raw syntax is not what is read.
  expect(dialog.textContent).not.toContain('**');
  expect(button('Edit', dialog)).toBeUndefined();
  expect(button('Delete', dialog)).toBeUndefined();
});

it('finds a skill by what it says and by who made it, accents and case aside', async () => {
  await show({
    builtinSkills: async () => [
      skill('schedules', 'Do something later, once or on a repetition.'),
      skill('web-research', 'Search the web and read public pages, citing each résumé.'),
    ],
  });

  await search('RESUME web');
  expect(names()).toEqual(['web-research']);

  await search(profile.name);
  expect(names()).toEqual(['trip-planning']);

  await search('example/skills');
  expect(names()).toEqual(['concise']);

  await search('zzz');
  expect(host.textContent).toContain('No skill matches.');
});

it('narrows the skills by who made them, and to the ones switched off', async () => {
  await show();

  await filterBy('By Jian');
  await vi.waitFor(() => expect(names()).toEqual(['web-research']));
  await filterBy('Imported');
  await vi.waitFor(() => expect(names()).toEqual(['concise']));
  await filterBy('By you');
  await vi.waitFor(() => expect(names()).toEqual(['standup-notes']));
  await filterBy('By agents');
  await vi.waitFor(() => expect(names()).toEqual(['trip-planning', 'invoice-check']));
  await filterBy('Off');
  await vi.waitFor(() => expect(names()).toEqual(['invoice-check']));
});

it('imports a skill from Add, by its address', async () => {
  const importSkill = vi.fn(async () => null);
  await show({ importSkill });

  await press('Add', host);
  await press('Import skill');
  const form = await opened();
  await type(form.querySelector('input'), 'https://github.com/example/skills/tree/main/tidy');
  await submit(form);

  expect(importSkill).toHaveBeenCalledWith('https://github.com/example/skills/tree/main/tidy');
});

it('writes a new skill from Add, into the library every agent shares', async () => {
  const createSkill = vi.fn(async () => null);
  await show({ createSkill });

  await press('Add', host);
  await press('Create skill');
  const form = await opened();
  await type(form.querySelector<HTMLInputElement>('input[name="name"]'), 'tidy-inbox');
  await type(form.querySelector<HTMLInputElement>('input[name="description"]'), 'Sort the mail.');
  const instructions = form.querySelector('textarea');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      instructions,
      'Oldest first.',
    );
    instructions?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await submit(form);

  expect(createSkill).toHaveBeenCalledWith({
    name: 'tidy-inbox',
    description: 'Sort the mail.',
    instructions: 'Oldest first.',
  });
});
