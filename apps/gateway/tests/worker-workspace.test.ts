import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '@jian/contracts';
import { afterAll, expect, it } from 'vitest';
import { fileTools } from '../src/agent/files.js';
import { shellTools } from '../src/agent/shell.js';
import { prepareWorkerWorkspace, removeWorkerWorkspace } from '../src/agent/worker-workspace.js';
import { sandboxAbi, workerWorkspacePath, workspaceOf } from '../src/agent/workspace.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-worker-')));
const previous = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;
const profileId = '11111111-1111-4111-8111-111111111111';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const worker = (id: string, repositories: string[], owner = profileId) =>
  ({ id, profileId: owner, subagent: { repositories } }) as Run;
const call = (tool: unknown, input: unknown) =>
  (tool as { execute: (input: unknown, context: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 'test',
    messages: [],
    context: {},
  });

afterAll(() => {
  if (previous === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previous;
  rmSync(root, { recursive: true, force: true });
});

it('gives subagents the same profile workspace as the principal, not a separate worktree', async () => {
  const home = await workspaceOf(profileId);
  const source = join(home, 'project');
  const sibling = join(home, 'sibling');
  mkdirSync(source);
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'notes.txt'), 'shared');
  git(source, 'init', '-q');
  writeFileSync(join(source, 'file.txt'), 'committed');
  git(source, 'add', 'file.txt');
  git(
    source,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'start',
  );

  const firstId = '22222222-2222-4222-8222-222222222222';
  const secondId = '33333333-3333-4333-8333-333333333333';
  const first = worker(firstId, [source]);
  const second = worker(secondId, [source, sibling]);
  const gitAccess = await prepareWorkerWorkspace(first);
  expect(gitAccess.ghConfigDir).toBe(join(home, '.config', 'gh'));
  expect(gitAccess.readOnly).toEqual([]);
  await prepareWorkerWorkspace(second);

  // Same HOME for every worker id — no _workers/<run> directory is created.
  expect(await workspaceOf(profileId)).toBe(home);
  expect(existsSync(workerWorkspacePath(profileId, firstId))).toBe(false);
  expect(existsSync(join(home, 'repos'))).toBe(false);

  const tools = fileTools(profileId);
  await call(tools.read_file, { path: join(source, 'file.txt'), offset: 1, limit: 10 });
  await call(tools.write_file, { path: join(source, 'file.txt'), content: 'worker edit' });
  expect(readFileSync(join(source, 'file.txt'), 'utf8')).toBe('worker edit');
  await call(tools.read_file, { path: join(sibling, 'notes.txt'), offset: 1, limit: 10 });
  expect(
    (await call(tools.list_directory, {
      path: home,
    })) as { entries: Array<{ name: string }> },
  ).toMatchObject({
    entries: expect.arrayContaining([
      expect.objectContaining({ name: 'project' }),
      expect.objectContaining({ name: 'sibling' }),
    ]),
  });

  const shell = shellTools(profileId, gitAccess).run_command;
  expect(await call(shell, { command: 'pwd', timeoutMs: 10_000 })).toMatchObject({
    exitCode: 0,
    stdout: `${home}\n`,
  });
  expect(
    await call(shell, { command: `git -C '${source}' status --porcelain`, timeoutMs: 10_000 }),
  ).toMatchObject({ exitCode: 0, stdout: ' M file.txt\n' });

  writeFileSync(join(source, 'dirty.txt'), 'uncommitted');
  // Uncommitted source changes are fine: Jian no longer prepares a detached worktree.
  await prepareWorkerWorkspace(worker('44444444-4444-4444-8444-444444444444', [source]));
  rmSync(join(source, 'dirty.txt'));

  await expect(
    prepareWorkerWorkspace(worker('55555555-5555-4555-8555-555555555555', [root])),
  ).rejects.toThrow('inside this agent');

  const linked = join(home, 'linked');
  symlinkSync(root, linked);
  await expect(
    prepareWorkerWorkspace(worker('66666666-6666-4666-8666-666666666666', [linked])),
  ).rejects.toThrow('inside this agent');

  // Legacy cleanup still removes old isolated worker homes if present.
  const legacy = workerWorkspacePath(profileId, firstId);
  mkdirSync(join(legacy, 'repos', '1'), { recursive: true });
  writeFileSync(join(legacy, 'scratch.txt'), 'old');
  await removeWorkerWorkspace(profileId, firstId, [source]);
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(source)).toBe(true);
});

it('lets Git SSH use the profile key from the shared workspace', async () => {
  const owner = '88888888-8888-4888-8888-888888888888';
  const home = await workspaceOf(owner);
  const ssh = join(home, '.ssh');
  mkdirSync(ssh, { mode: 0o700 });
  writeFileSync(join(ssh, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n');
  writeFileSync(join(ssh, 'config'), 'Host bitbucket.org\n  User git\n');
  writeFileSync(join(ssh, 'known_hosts'), 'bitbucket.org synthetic-host-key\n');
  const runId = '99999999-9999-4999-8999-999999999999';
  const access = await prepareWorkerWorkspace(worker(runId, [], owner));
  expect(existsSync(workerWorkspacePath(owner, runId))).toBe(false);
  const shell = shellTools(owner, access).run_command;
  const config = (await call(shell, {
    command: 'eval "$GIT_SSH_COMMAND -G bitbucket.org"',
    timeoutMs: 10_000,
  })) as { exitCode: number; stdout: string };
  expect(config.exitCode).toBe(0);
  expect(config.stdout).toContain(`identityfile ${join(ssh, 'id_ed25519')}`);
  expect(config.stdout).toContain('user git');
  expect(
    await call(shell, {
      command: 'git ls-remote --get-url https://bitbucket.org/vxcaselabs/vx-erp.git',
      timeoutMs: 10_000,
    }),
  ).toMatchObject({ exitCode: 0, stdout: 'git@bitbucket.org:vxcaselabs/vx-erp.git\n' });
  if ((await sandboxAbi()) > 0) {
    // Profile isolation still holds: another profile's home is not writable.
    const other = await workspaceOf(profileId);
    expect(
      await call(shell, {
        command: `printf corrupted > '${join(other, 'planted.txt')}'`,
        timeoutMs: 10_000,
      }),
    ).not.toMatchObject({ exitCode: 0 });
  }
  expect(readFileSync(join(ssh, 'id_ed25519'), 'utf8')).toContain('synthetic');
});
