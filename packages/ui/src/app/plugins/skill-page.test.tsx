import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BuiltinSkill, GatewayApi, LibrarySkill } from '../../lib/api';
import { librarySkills, profile } from '../../test/fixtures';
import { SkillPage } from './skill-page';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const address = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock('../../platform/navigation', () => ({
  useRouter: () => ({ replace: address.replace, push: address.push }),
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
vi.mock('../../lib/query/client', () => ({
  panelApi: () => ({
    profiles: async () => [profile],
    health: async () => ({ status: 'ok', service: 'jian', version: '1.4.2' }),
  }),
}));

const research: BuiltinSkill = {
  name: 'web-research',
  description: 'Search the web and read public pages.',
  instructions: '# Find it\n\nUse **the web** first.\n\n- one\n- two',
  enabled: true,
};
const [concise] = librarySkills as [LibrarySkill];
const SKILLS = '/agents/a1/plugins?tab=skills';

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  address.replace.mockClear();
  address.push.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

async function show(name: string, api: Record<string, unknown> = {}) {
  actions.api = {
    skills: async () => librarySkills,
    builtinSkills: async () => [research],
    skillUpstream: async () => ({ changed: false, checkedAt: concise.updatedAt }),
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
          <SkillPage name={name} />
        </Suspense>
      </QueryClientProvider>,
    ),
  );
  // The agents and both lists of skills arrive after the first render.
  await act(async () => {
    await vi.waitFor(() => expect(host.querySelector('[role="status"]')).toBeNull());
  });
}

const button = (name: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );
const press = async (name: string, within?: ParentNode) => {
  const found = button(name, within);
  if (!found) throw new Error(`no ${name}`);
  await act(async () => found.click());
};
const type = (input: HTMLInputElement | null | undefined, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
/** What the details column says under one of its labels. */
const detail = (label: string) =>
  [...host.querySelectorAll('dl[aria-label="Details"] dt')].find(
    (term) => term.textContent === label,
  )?.nextElementSibling;
const toggle = () =>
  host.querySelector<HTMLElement>('[role="switch"][aria-label="On for every agent"]');

it('reads a built-in skill as Jian wrote it, with nothing to edit or delete', async () => {
  await show('web-research');

  const heading = host.querySelector('h1');
  expect(heading?.textContent).toBe('web-research');
  expect(heading?.querySelector('[aria-label="Verified"]')).not.toBeNull();
  expect(host.querySelector('header')?.textContent).toContain(
    'By Jian · Search the web and read public pages.',
  );
  // The heading written in the skill is inside `.markdown`, rendered: no raw syntax is read.
  expect(host.querySelector('.markdown h3')?.textContent).toBe('Find it');
  expect(host.querySelector('.markdown strong')?.textContent).toBe('the web');
  expect(host.querySelectorAll('.markdown li')).toHaveLength(2);
  expect(host.querySelector('.markdown')?.textContent).not.toContain('**');

  expect(detail('Made by')?.textContent).toBe('Jian');
  expect(detail('Made by')?.querySelector('[aria-label="Verified"]')).not.toBeNull();
  expect(detail('Status')?.textContent).toBe('On for every agent');
  expect(detail('Access')?.textContent).toContain('Adds instructions only');
  expect(detail('Source')?.textContent).toBe('Ships with Jian');
  await vi.waitFor(() => expect(detail('Version')?.textContent).toBe('Jian 1.4.2'));
  expect(detail('Updates')).toBeUndefined();
  expect(detail('Added')).toBeUndefined();

  expect(button('Edit', host)).toBeUndefined();
  await press('More', host);
  expect(button('Copy instructions')).toBeDefined();
  expect(button('Open on GitHub')).toBeUndefined();
  expect(button('Delete')).toBeUndefined();
});

it('says whose a skill of the library is: the owner, an agent, or one since deleted', async () => {
  await show('standup-notes');
  expect(detail('Made by')?.textContent).toBe('You');
  expect(detail('Source')).toBeUndefined();
  expect(detail('Version')?.textContent).toBe('v1 · updated 17 Sept');
  expect(detail('Added')?.textContent).toBe('September 2026');
  expect(detail('Updates')).toBeUndefined();
  expect(button('Edit', host)).toBeDefined();
  await act(async () => root?.unmount());

  await show('trip-planning');
  expect(detail('Made by')?.textContent).toBe(profile.name);
  expect(host.querySelector('header')?.textContent).toContain(`By ${profile.name} · Plan a trip`);
  await act(async () => root?.unmount());

  await show('invoice-check');
  expect(detail('Made by')?.textContent).toBe('An agent');
  expect(detail('Status')?.textContent).toBe('Off');
  expect(toggle()?.getAttribute('aria-checked')).toBe('false');
});

it('shows where an imported skill came from, its version and that it is up to date', async () => {
  const skillUpstream = vi.fn(async () => ({ changed: false, checkedAt: concise.updatedAt }));
  await show('concise', { skillUpstream });

  expect(detail('Made by')?.textContent).toBe('Imported');
  const source = detail('Source')?.querySelector('a');
  expect(source?.textContent).toBe('example/skills');
  expect(source?.getAttribute('href')).toBe('https://github.com/example/skills');
  expect(source?.getAttribute('target')).toBe('_blank');
  expect(detail('Version')?.textContent).toBe('v3 · updated 17 Sept · from main');
  expect(detail('License')?.textContent).toBe('MIT');
  expect(detail('Imported')?.textContent).toBe('17 Sept 2026');
  // Up to date is the usual case, and says nothing: the version line stays as it was.
  await vi.waitFor(() => expect(skillUpstream).toHaveBeenCalledWith('concise'));
  expect(detail('Version')?.textContent).toBe('v3 · updated 17 Sept · from main');
  expect(button('Update to the latest version', host)).toBeUndefined();
  expect(detail('Updates')).toBeUndefined();

  await press('More', host);
  expect(button('Open on GitHub')).toBeDefined();
  expect(button('Delete')).toBeDefined();
});

it('copies an imported skill from its source again when that changed', async () => {
  const updateSkillFromSource = vi.fn(async () => concise);
  await show('concise', {
    skillUpstream: async () => ({ changed: true, checkedAt: concise.updatedAt }),
    updateSkillFromSource,
  });
  // On the version's own line, with the button that takes it: no row of its own.
  await vi.waitFor(() =>
    expect(detail('Version')?.textContent).toBe(
      'v3 · updated 17 Sept · from main · Update available',
    ),
  );
  expect(detail('Updates')).toBeUndefined();
  expect(button('Update to the latest version', host)?.getAttribute('title')).toBe(
    'Update to the latest version',
  );

  await press('Update to the latest version', host);

  // Never edited here, so there is nothing to ask about.
  expect(updateSkillFromSource).toHaveBeenCalledWith('concise');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await vi.waitFor(() =>
    expect(detail('Version')?.textContent).toBe('v3 · updated 17 Sept · from main'),
  );
});

it('asks before an update replaces what was edited here since the import', async () => {
  const updateSkillFromSource = vi.fn(async () => concise);
  const edited = {
    ...concise,
    updatedAt: new Date(Date.parse(concise.updatedAt) + 60_000).toISOString(),
  };
  await show('concise', {
    skills: async () => [edited],
    skillUpstream: async () => ({ changed: true, checkedAt: edited.updatedAt }),
    updateSkillFromSource,
  });
  await vi.waitFor(() => expect(detail('Version')?.textContent).toContain('Update available'));

  await press('Update to the latest version', host);
  expect(updateSkillFromSource).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    'It was edited here after it was imported.',
  );

  await press('Update skill');
  expect(updateSkillFromSource).toHaveBeenCalledWith('concise');
});

it('says when the source could not be asked, and leaves the skill as it is', async () => {
  await show('concise', {
    skillUpstream: async () => Promise.reject(new Error('GitHub could not be reached')),
  });

  await vi.waitFor(() =>
    expect(detail('Version')?.textContent).toBe(
      'v3 · updated 17 Sept · from main · Couldn’t check',
    ),
  );
  expect(button('Update to the latest version', host)).toBeUndefined();
  expect(button('Check again', host)).toBeDefined();
  expect(host.querySelector('.markdown')?.textContent).toContain('Lead with the answer.');
});

it('shows the skill as the document it is kept as', async () => {
  await show('concise');

  await press('SKILL.md', host);

  const code = () => host.querySelector('.code-block code')?.textContent ?? '';
  expect(code()).toContain(
    '---\nname: concise\ndescription: Answer in the first sentence; every word earns its place.\nlicense: MIT\n---\n\nLead with the answer.',
  );
  expect(button('Copy the code', host)).toBeDefined();
  await act(async () => root?.unmount());

  // A value with a mark of YAML's own is quoted, so the document still parses.
  await show('trip-planning');
  await press('SKILL.md', host);
  expect(code()).toContain(
    'description: "Plan a trip: dates first, then stays, then the way between them."\n---\n',
  );
});

it('edits a skill of the library in its page, under the name it has', async () => {
  const updateSkill = vi.fn(async () => null);
  // An agent wrote this one; the owner edits it all the same.
  await show('trip-planning', { updateSkill });

  await press('Edit', host);

  // In the overview's place, not over the page.
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const form = host.querySelector('form');
  expect(form?.querySelector<HTMLInputElement>('input[name="name"]')?.readOnly).toBe(true);
  expect(button('Edit', host)).toBeUndefined();
  await type(form?.querySelector<HTMLInputElement>('input[name="description"]'), 'Dates first.');
  await press('Save', host);

  expect(updateSkill).toHaveBeenCalledWith('trip-planning', {
    description: 'Dates first.',
    instructions: 'Ask for the dates before anything else.',
  });
  // Saved, the page reads again.
  expect(host.querySelector('form')).toBeNull();
  expect(button('Edit', host)).toBeDefined();
});

it('leaves a skill as it was when the edit is cancelled, and keeps the form when it is refused', async () => {
  const updateSkill = vi.fn(async () => Promise.reject(new Error('The gateway is unreachable.')));
  await show('standup-notes', { updateSkill });

  await press('Edit', host);
  await press('Save', host);
  expect(updateSkill).toHaveBeenCalled();
  expect(host.querySelector('form')).not.toBeNull();

  await press('Cancel', host);
  expect(host.querySelector('form')).toBeNull();
  expect(host.querySelector('.markdown')?.textContent).toContain('Yesterday, today, blockers.');
});

it('deletes a skill only once its name is typed, then goes back to the skills', async () => {
  const deleteSkill = vi.fn(async () => null);
  await show('trip-planning', { deleteSkill });

  await press('More', host);
  await press('Delete');
  const confirm = button('Delete skill') as HTMLButtonElement | undefined;
  expect(confirm?.disabled).toBe(true);

  await type(confirm?.closest('[role="dialog"]')?.querySelector('input'), 'trip-planning');
  await act(async () => confirm?.click());

  expect(deleteSkill).toHaveBeenCalledWith('trip-planning');
  expect(address.replace).toHaveBeenCalledWith(SKILLS);
});

it('switches a skill for every agent at once, and puts it back when the gateway refuses', async () => {
  let refuse: (reason: Error) => void = () => {};
  const setSkillEnabled = vi.fn(
    () =>
      new Promise((_, reject) => {
        refuse = reject;
      }),
  );
  await show('web-research', { setSkillEnabled });
  expect(toggle()?.getAttribute('aria-checked')).toBe('true');

  await act(async () => toggle()?.click());

  // Shown off while the gateway has not answered, on the switch and in the details.
  expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  expect(detail('Status')?.textContent).toBe('Off');
  expect(setSkillEnabled).toHaveBeenCalledWith('web-research', false);

  await act(async () => refuse(new Error('The gateway is unreachable.')));
  expect(toggle()?.getAttribute('aria-checked')).toBe('true');
  expect(detail('Status')?.textContent).toBe('On for every agent');
});

it('says so when the address names no skill, with the way back to Plugins', async () => {
  await show('gone-skill');

  expect(host.textContent).toContain('No skill named gone-skill.');
  expect(host.querySelector('h1')).toBeNull();

  await press('Plugins', host);
  expect(address.push).toHaveBeenCalledWith(SKILLS);
});
