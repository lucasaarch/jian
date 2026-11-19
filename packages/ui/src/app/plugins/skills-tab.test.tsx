import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BuiltinSkill, GatewayApi } from '../../lib/api';
import { librarySkills, profile } from '../../test/fixtures';
import { PluginsScreen } from './plugins-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const address = vi.hoisted(() => ({ query: '', replace: vi.fn(), push: vi.fn() }));
vi.mock('../../platform/navigation', () => ({
  usePathname: () => '/agents/a1/plugins',
  useRouter: () => ({ replace: address.replace, push: address.push }),
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
  useProfileId: () => 'a1',
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
  address.push.mockClear();
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
/** Opens a skill from its row, as a click on it does. */
const open = async (name: string) => {
  const found = row(name)?.querySelector('button');
  if (!found) throw new Error(`no row ${name}`);
  await act(async () => found.click());
};
const type = (input: HTMLInputElement | null | undefined, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
const search = (text: string) =>
  type(host.querySelector<HTMLInputElement>('input[aria-label="Search plugins"]'), text);

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
  expect(names('Library')).toHaveLength(librarySkills.length);
  // The search and the tabs narrow the list: the Skills tab has no filter of its own.
  expect(button('Filter skills', host)).toBeUndefined();

  await press('All', host);
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

it('opens a skill on its own page from its row, on the Skills tab and on All', async () => {
  await show();

  await open('trip-planning');
  expect(address.push).toHaveBeenLastCalledWith('/agents/a1/plugins/skills/trip-planning');
  await open('web-research');
  expect(address.push).toHaveBeenLastCalledWith('/agents/a1/plugins/skills/web-research');
  // A page, not something over this one.
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  await press('All', host);
  await open('concise');
  expect(address.push).toHaveBeenLastCalledWith('/agents/a1/plugins/skills/concise');
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

/** Imports from Add what the gateway then answers with. */
const importing = async (imported: unknown[]) => {
  const importSkill = vi.fn(async () => imported);
  await show({ importSkill });

  await press('Add', host);
  await press('Import skill');
  const form = await opened();
  await type(form.querySelector('input'), 'https://github.com/example/skills/tree/main/tidy');
  await submit(form);

  return importSkill;
};

it('imports a skill from Add, by its address, and opens its page', async () => {
  const importSkill = await importing([librarySkills[0]]);

  expect(importSkill).toHaveBeenCalledWith('https://github.com/example/skills/tree/main/tidy');
  expect(address.push).toHaveBeenCalledWith('/agents/a1/plugins/skills/concise');
});

it('stays on the list after importing a folder of skills', async () => {
  await importing(librarySkills.slice(0, 2));

  expect(address.push).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"] form')).toBeNull());
});

/** Writes a skill in the form Add opens, and sends it. */
const writing = async (name: string) => {
  await press('Add', host);
  await press('Create skill');
  const form = await opened();
  await type(form.querySelector<HTMLInputElement>('input[name="name"]'), name);
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
};

it('writes a new skill from Add, into the library every agent shares, and opens its page', async () => {
  const createSkill = vi.fn(async () => null);
  await show({ createSkill });

  await writing('tidy-inbox');

  expect(createSkill).toHaveBeenCalledWith({
    name: 'tidy-inbox',
    description: 'Sort the mail.',
    instructions: 'Oldest first.',
  });
  expect(address.push).toHaveBeenCalledWith('/agents/a1/plugins/skills/tidy-inbox');
});

it('stays on the form when the gateway refuses the new skill', async () => {
  const createSkill = vi.fn(async () => Promise.reject(new Error('That name is taken.')));
  await show({ createSkill });

  await writing('concise');

  expect(createSkill).toHaveBeenCalled();
  expect(address.push).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"] form')).not.toBeNull();
});
