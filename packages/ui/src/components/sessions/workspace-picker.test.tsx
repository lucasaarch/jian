import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionGlobalConfig } from 'motion/react';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { keys } from '../../lib/query/keys';
import {
  FROM_SCRATCH,
  useWorkspaces,
  type WorkspaceChoice,
} from '../../lib/stores/workspace-choice';
import { type ThisMachine, ThisMachineProvider } from '../../lib/this-machine';
import { PlacePicker, ProjectPicker } from './workspace-picker';

const repository = {
  id: 7,
  accountId: 'account',
  name: 'atlas',
  fullName: 'acme/atlas',
  ownerLogin: 'acme',
  private: false,
  htmlUrl: 'https://github.com/acme/atlas',
  cloneUrl: 'https://github.com/acme/atlas.git',
};
const second = { ...repository, id: 8, name: 'harbor', fullName: 'acme/harbor' };

const here = (fields: Partial<ThisMachine> = {}): ThisMachine => ({
  pickFolder: vi.fn(async () => '/work/atlas'),
  machineId: 'this-machine',
  ownGateway: false,
  sharing: true,
  setSharing: vi.fn(),
  ...fields,
});

const roots: (() => void)[] = [];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useWorkspaces.setState({ folders: [], next: undefined });
  // The side list animates, and a frame left over after a test has no window to draw in.
  MotionGlobalConfig.skipAnimations = true;
});
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  MotionGlobalConfig.skipAnimations = false;
  document.body.innerHTML = '';
});

async function show({
  mode = 'server',
  machine,
  start = FROM_SCRATCH,
}: {
  mode?: 'server' | 'local';
  machine?: ThisMachine;
  start?: WorkspaceChoice;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  });
  client.setQueryData(keys.gateway, { status: 'ok', version: '1.0.0', mode });
  client.setQueryData(keys.githubRepositories, [repository, second]);
  client.setQueryData(keys.githubIntegration, { accounts: [{ id: 'account' }] });
  client.setQueryData(keys.remoteMachines, [
    { id: 'this-machine', name: 'This one', online: true },
    { id: 'studio', name: 'Studio', online: true },
    { id: 'sleeping', name: 'Sleeping', online: false },
  ]);
  const seen: { choice: WorkspaceChoice } = { choice: start };
  function Both() {
    const [choice, setChoice] = useState(start);
    seen.choice = choice;
    return (
      <ThisMachineProvider value={machine}>
        <ProjectPicker choice={choice} onChange={setChoice} />
        <PlacePicker choice={choice} onChange={setChoice} />
      </ThisMachineProvider>
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Both />
      </QueryClientProvider>,
    ),
  );
  const button = (name: string) =>
    // The last: an open list comes after the trigger that shares its words, as Cloud does.
    [...document.querySelectorAll<HTMLButtonElement>('button')].findLast(
      (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );
  const press = async (name: string) => {
    const found = button(name);
    if (!found) throw new Error(`No button ${name}`);
    await act(async () => found.click());
  };
  return { seen, button, press };
}

it('offers a browser only the repositories: it cannot reach the computer it runs on', async () => {
  const view = await show({});
  await view.press('Project');

  expect(view.button('This Machine')).toBeUndefined();
  expect(view.button('Cloud')).toBeDefined();
});

it('offers an app on its own gateway only this computer, with no place to choose', async () => {
  const view = await show({ mode: 'local', machine: here({ machineId: null, ownGateway: true }) });

  expect(view.button('Local')).toBeUndefined();
  await view.press('Project');
  // Straight to its folders, with nothing to pick between first.
  expect(view.button('This Machine')).toBeUndefined();
  expect(view.button('Cloud')).toBeUndefined();
  expect(view.button('Open folder…')).toBeDefined();
  expect(view.button('Start from scratch')).toBeDefined();

  await view.press('Open folder…');
  expect(view.seen.choice).toEqual({ kind: 'folders', folders: ['/work/atlas'] });
  await view.press('Project');
  await view.press('Start from scratch');
  expect(view.seen.choice).toEqual(FROM_SCRATCH);
});

it('keeps a folder picked once in This Machine’s list, and starts on it', async () => {
  const view = await show({ machine: here() });
  await view.press('Project');
  await view.press('This Machine');
  await view.press('Open folder…');

  expect(view.seen.choice).toEqual({ kind: 'folders', folders: ['/work/atlas'] });
  expect(useWorkspaces.getState().folders).toEqual(['/work/atlas']);

  await view.press('Project');
  await view.press('This Machine');
  expect(view.button('/work/atlas')).toBeDefined();
});

it('picks several repositories with Select multiple, and one closes the list otherwise', async () => {
  const view = await show({});
  await view.press('Project');
  await view.press('Cloud');
  await act(async () => document.querySelector<HTMLElement>('[role="switch"]')?.click());
  await view.press('acme/atlas');
  await view.press('acme/harbor');

  expect(view.seen.choice).toMatchObject({
    kind: 'repositories',
    repositories: [{ name: 'acme/atlas' }, { name: 'acme/harbor' }],
  });
  expect(view.button('acme/atlas')).toBeDefined();
});

it('says folders stay on this machine, with nothing to change', async () => {
  const view = await show({
    machine: here(),
    start: { kind: 'folders', folders: ['/work/atlas'] },
  });

  expect(view.button('Local')).toBeUndefined();
  expect(document.body.textContent).toContain('This Machine');
});

it('lists the cloud, online machines other than this one, and this one by a folder', async () => {
  const machine = here();
  const view = await show({
    machine,
    start: {
      kind: 'repositories',
      repositories: [{ name: 'acme/atlas' }],
      place: { kind: 'cloud' },
    },
  });
  await view.press('Local');

  expect(view.button('Studio')).toBeDefined();
  expect(view.button('Sleeping')).toBeUndefined();
  expect(view.button('This one')).toBeUndefined();

  await view.press('This Machine…');
  expect(machine.pickFolder).toHaveBeenCalledOnce();
  expect(view.seen.choice).toMatchObject({ place: { kind: 'here', cloneInto: '/work/atlas' } });
});

it('stays where it was when the folder dialog is cancelled', async () => {
  const machine = here({ pickFolder: vi.fn(async () => null) });
  const view = await show({
    machine,
    start: {
      kind: 'repositories',
      repositories: [{ name: 'acme/atlas' }],
      place: { kind: 'cloud' },
    },
  });
  await view.press('Local');
  await view.press('This Machine…');

  expect(view.seen.choice).toMatchObject({ place: { kind: 'cloud' } });
});

it('asks to share this computer before offering its folders on a server', async () => {
  const setSharing = vi.fn();
  const view = await show({ machine: here({ machineId: null, sharing: false, setSharing }) });
  await view.press('Project');
  await view.press('This Machine');

  expect(view.button('Open folder…')).toBeUndefined();
  expect(document.body.textContent).toContain('shared');
  await act(async () => document.querySelector<HTMLElement>('[role="switch"]')?.click());
  expect(setSharing).toHaveBeenCalledWith(true);
});

it('offers only a start from scratch and the workspaces, with nothing to search', async () => {
  useWorkspaces.setState({ folders: ['/work/atlas'] });
  const view = await show({ machine: here() });
  await view.press('Project');

  expect(document.body.textContent).not.toContain('Recents');
  expect(document.querySelector('input[aria-label="Search projects"]')).toBeNull();
  expect(document.body.textContent).not.toContain('Workspaces');
  expect(view.button('atlas')).toBeUndefined();
  expect(view.button('Start from scratch')).toBeDefined();
});

it('says there are no folders yet, instead of leaving an empty gap', async () => {
  const view = await show({ machine: here() });
  await view.press('Project');
  await view.press('This Machine');

  expect(document.querySelector('input[aria-label="Search folders"]')).not.toBeNull();
  expect(document.body.textContent).toContain('No folders yet');
});

it('opens a place where the pointer rests, not on the way past it', async () => {
  const view = await show({ machine: here() });
  await view.press('Project');
  const over = (name: string) =>
    act(async () => {
      view.button(name)?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
  const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

  await over('This Machine');
  await over('Start from scratch');
  await wait(150);
  expect(document.querySelector('input[aria-label="Search folders"]')).toBeNull();

  await over('This Machine');
  await wait(150);
  expect(document.querySelector('input[aria-label="Search folders"]')).not.toBeNull();
});
