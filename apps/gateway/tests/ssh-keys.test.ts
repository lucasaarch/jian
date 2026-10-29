import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { workspaceOf } from '../src/agent/workspace.js';
import { importWorkspaceSshKeys } from '../src/ssh/import.js';
import { sshKeySecret } from '../src/ssh/service.js';
import { testServices } from './helpers/services.js';

const root = realpathSync(mkdtempSync(join('/tmp', 'jian-ssh-')));
const previous = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;

afterAll(() => {
  if (previous === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previous;
  rmSync(root, { recursive: true, force: true });
});

it('keeps one set of keys for every agent and writes them into each workspace at a run', async () => {
  const services = await testServices();
  const first = await services.profiles.createProfile({ name: 'Atlas', instructions: 'Help.' });
  const second = await services.profiles.createProfile({ name: 'Zero', instructions: 'Help.' });

  const created = await services.sshKeys.create({ name: 'GitHub' });
  expect(created.publicKey).toMatch(/^ssh-ed25519 /);
  expect(created.fingerprint).toMatch(/^SHA256\//);
  expect(JSON.stringify(created)).not.toContain('PRIVATE KEY');
  expect(await services.sshKeys.list()).toEqual([created]);

  // Both agents get the same key; the private half reaches a workspace only as git's file.
  for (const profile of [first, second]) {
    const home = await workspaceOf(profile.id);
    await services.sshKeys.sync(home);
    const privateKey = join(home, '.ssh', 'jian', created.id, 'id_ed25519');
    expect(statSync(privateKey).mode & 0o777).toBe(0o600);
    expect(
      execFileSync('/usr/bin/ssh-keygen', ['-y', '-f', privateKey], { encoding: 'utf8' }).trim(),
    ).toBe(created.publicKey.split(' ').slice(0, 2).join(' '));
  }

  await expect(services.sshKeys.remove(created.id)).resolves.toEqual({ id: created.id });
  expect(await services.gatewayVault.read(sshKeySecret(created.id))).toBeUndefined();
  await expect(services.sshKeys.remove(created.id)).rejects.toMatchObject({ statusCode: 404 });

  // The next run takes it out of the workspace, and leaves what is not a key alone.
  const home = await workspaceOf(first.id);
  mkdirSync(join(home, '.ssh', 'jian', 'notes'), { recursive: true });
  await services.sshKeys.sync(home);
  expect(existsSync(join(home, '.ssh', 'jian', created.id))).toBe(false);
  expect(existsSync(join(home, '.ssh', 'jian', 'notes'))).toBe(true);
});

it('imports the keys agents made in their own workspaces, once, and without duplicates', async () => {
  const services = await testServices();
  const create = (name: string) => services.profiles.createProfile({ name, instructions: 'Help.' });
  const atlas = await create('Atlas');
  const zero = await create('Zero');
  const nova = await create('Nova');
  const id = randomUUID();
  const legacy = join(await workspaceOf(atlas.id), '.ssh', 'jian', id);
  mkdirSync(legacy, { recursive: true });
  execFileSync('/usr/bin/ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    'jian-Deploy',
    '-f',
    join(legacy, 'id_ed25519'),
  ]);
  writeFileSync(
    join(legacy, 'metadata.json'),
    JSON.stringify({
      id,
      name: 'Deploy',
      fingerprint: 'SHA256/synthetic',
      createdAt: '2026-09-01T10:00:00.000Z',
    }),
  );
  // The same key copied into another workspace, and an entry a failed generation left behind.
  cpSync(legacy, join(await workspaceOf(zero.id), '.ssh', 'jian', randomUUID()), {
    recursive: true,
  });
  mkdirSync(join(await workspaceOf(zero.id), '.ssh', 'jian', randomUUID()), { recursive: true });

  expect(await importWorkspaceSshKeys(services.store, services.gatewayVault)).toBe(1);
  expect(await importWorkspaceSshKeys(services.store, services.gatewayVault)).toBe(0);

  const [key] = await services.sshKeys.list();
  expect(await services.sshKeys.list()).toHaveLength(1);
  expect(key).toMatchObject({ id, name: 'Deploy', createdAt: '2026-09-01T10:00:00.000Z' });
  expect(key?.publicKey).toBe(readFileSync(join(legacy, 'id_ed25519.pub'), 'utf8').trim());

  // An agent that never had it now gets it too.
  const home = await workspaceOf(nova.id);
  await services.sshKeys.sync(home);
  expect(readFileSync(join(home, '.ssh', 'jian', id, 'id_ed25519'), 'utf8')).toBe(
    readFileSync(join(legacy, 'id_ed25519'), 'utf8'),
  );
});
