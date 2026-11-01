import { expect, it, vi } from 'vitest';
import type { Project, Session } from '../../lib/api';
import { FROM_SCRATCH, folderName } from '../../lib/stores/workspace-choice';
import type { ThisMachine } from '../../lib/this-machine';
import { choiceLabel, choiceOfSession, workspaceInput } from './workspace-choice';

const here = (machineId: string | null, ownGateway = false): ThisMachine => ({
  pickFolder: async () => null,
  machineId,
  ownGateway,
  sharing: Boolean(machineId),
  setSharing: () => {},
});
const repository = { name: 'acme/atlas', githubAccountId: 'account', githubRepositoryId: 7 };
const api = () => ({ ensureProject: vi.fn(async () => ({ id: 'opened' }) as never) });

it('reaches this computer’s folders through its machine on a server', async () => {
  const input = await workspaceInput(
    api(),
    'agent',
    { kind: 'folders', folders: ['/work/atlas', '/work/harbor'] },
    here('this-machine'),
  );

  expect(input).toEqual({
    folders: ['/work/atlas', '/work/harbor'],
    remoteMachineId: 'this-machine',
  });
});

it('needs no machine for folders on the app’s own gateway', async () => {
  const input = await workspaceInput(
    api(),
    'agent',
    { kind: 'folders', folders: ['/work/atlas'] },
    here(null, true),
  );

  expect(input).toEqual({ folders: ['/work/atlas'] });
});

it('opens a repository as a project only when the chat starts', async () => {
  const calls = api();
  const input = await workspaceInput(
    calls,
    'agent',
    { kind: 'repositories', repositories: [repository], place: { kind: 'cloud' } },
    undefined,
  );

  expect(calls.ensureProject).toHaveBeenCalledWith('agent', {
    githubAccountId: 'account',
    githubRepositoryId: 7,
  });
  expect(input).toEqual({ projectIds: ['opened'] });
});

it('reuses a project the agent already has', async () => {
  const calls = api();
  await workspaceInput(
    calls,
    'agent',
    {
      kind: 'repositories',
      repositories: [{ ...repository, projectId: 'known' }],
      place: { kind: 'cloud' },
    },
    undefined,
  );

  expect(calls.ensureProject).not.toHaveBeenCalled();
});

it('clones into the folder picked on this machine, or works on the machine chosen', async () => {
  const on = (place: never) =>
    workspaceInput(
      api(),
      'agent',
      { kind: 'repositories', repositories: [repository], place },
      here('this-machine'),
    );

  await expect(on({ kind: 'here', cloneInto: '/work' } as never)).resolves.toEqual({
    projectIds: ['opened'],
    remoteMachineId: 'this-machine',
    cloneInto: '/work',
  });
  await expect(on({ kind: 'machine', id: 'studio' } as never)).resolves.toEqual({
    projectIds: ['opened'],
    remoteMachineId: 'studio',
  });
});

it('says what a repository that is no longer connected is, instead of failing silently', async () => {
  await expect(
    workspaceInput(
      api(),
      'agent',
      {
        kind: 'repositories',
        repositories: [{ name: 'acme/atlas' }],
        place: { kind: 'cloud' },
      },
      undefined,
    ),
  ).rejects.toThrow('acme/atlas');
});

it('starts a chat like one in a folder', () => {
  const project = { id: 'p1', name: 'acme/atlas' } as Project;
  const session = (fields: Partial<Session>) => fields as Session;

  expect(choiceOfSession(session({ folders: ['/work/atlas'] }), [], undefined)).toEqual({
    kind: 'folders',
    folders: ['/work/atlas'],
  });
  expect(
    choiceOfSession(session({ projectId: 'p1', remoteMachineId: 'studio' }), [project], undefined),
  ).toMatchObject({
    kind: 'repositories',
    repositories: [{ name: 'acme/atlas', projectId: 'p1' }],
    place: { kind: 'machine', id: 'studio' },
  });
});

it('names the choice as the trigger shows it', () => {
  expect(choiceLabel(FROM_SCRATCH, folderName)).toBe('Start from scratch');
  expect(choiceLabel({ kind: 'folders', folders: ['/work/atlas/'] }, folderName)).toBe('atlas');
  expect(
    choiceLabel({ kind: 'folders', folders: ['/work/atlas', '/work/harbor'] }, folderName),
  ).toBe('atlas + 1');
  expect(
    choiceLabel(
      { kind: 'repositories', repositories: [repository], place: { kind: 'cloud' } },
      folderName,
    ),
  ).toBe('atlas');
});
