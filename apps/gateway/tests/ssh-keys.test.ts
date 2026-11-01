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
import { afterAll, beforeEach, expect, it } from 'vitest';
import { workspaceHome } from '../src/agent/workspace-home.js';
import { importWorkspaceSshKeys } from '../src/ssh/import.js';
import { sshKeySecret } from '../src/ssh/service.js';
import { testServices } from './helpers/services.js';

const base = realpathSync(mkdtempSync(join('/tmp', 'jian-ssh-')));
const previous = process.env.JIAN_WORKSPACES;
let root = '';

// Agents share one directory, so each test takes its own for the keys it sees to be its own.
beforeEach(() => {
  root = join(base, randomUUID());
  process.env.JIAN_WORKSPACES = root;
});

afterAll(() => {
  if (previous === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previous;
  rmSync(base, { recursive: true, force: true });
});

/** A key as an earlier version left it, only as files in one agent's folder. */
function earlierKey(profileId: string, id: string, name: string) {
  const folder = join(root, profileId, '.ssh', 'jian', id);
  mkdirSync(folder, { recursive: true });
  execFileSync('/usr/bin/ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    `jian-${name}`,
    '-f',
    join(folder, 'id_ed25519'),
  ]);
  writeFileSync(
    join(folder, 'metadata.json'),
    JSON.stringify({
      id,
      name,
      fingerprint: 'SHA256/synthetic',
      createdAt: '2026-09-01T10:00:00.000Z',
    }),
  );
  return folder;
}

it('keeps one set of keys in the shared directory, and takes one out when it is removed', async () => {
  const services = await testServices();

  const created = await services.sshKeys.create({ name: 'GitHub' });
  expect(created.publicKey).toMatch(/^ssh-ed25519 /);
  expect(created.fingerprint).toMatch(/^SHA256\//);
  expect(JSON.stringify(created)).not.toContain('PRIVATE KEY');
  expect(await services.sshKeys.list()).toEqual([created]);

  // The private half reaches the disk only as git's file.
  await services.sshKeys.sync();
  const home = await workspaceHome();
  const privateKey = join(home, '.ssh', 'jian', created.id, 'id_ed25519');
  expect(statSync(privateKey).mode & 0o777).toBe(0o600);
  expect(
    execFileSync('/usr/bin/ssh-keygen', ['-y', '-f', privateKey], { encoding: 'utf8' }).trim(),
  ).toBe(created.publicKey.split(' ').slice(0, 2).join(' '));

  await expect(services.sshKeys.remove(created.id)).resolves.toEqual({ id: created.id });
  expect(await services.gatewayVault.read(sshKeySecret(created.id))).toBeUndefined();
  await expect(services.sshKeys.remove(created.id)).rejects.toMatchObject({ statusCode: 404 });
  expect(existsSync(join(home, '.ssh', 'jian', created.id))).toBe(false);

  // A sync leaves what is not a key alone.
  mkdirSync(join(home, '.ssh', 'jian', 'notes'), { recursive: true });
  await services.sshKeys.sync();
  expect(existsSync(join(home, '.ssh', 'jian', 'notes'))).toBe(true);
});

it('never shows a run a half-written key while another run syncs', async () => {
  const services = await testServices();
  const { id } = await services.sshKeys.create({ name: 'Deploy' });
  await services.sshKeys.sync();
  const file = join(await workspaceHome(), '.ssh', 'jian', id, 'id_ed25519');
  const whole = readFileSync(file, 'utf8');
  const before = statSync(file).ino;

  await Promise.all(Array.from({ length: 8 }, () => services.sshKeys.sync()));

  // Nothing changed, so nothing was rewritten: not even a moment with the file open for writing.
  expect(readFileSync(file, 'utf8')).toBe(whole);
  expect(statSync(file).ino).toBe(before);

  // One that did change, written by several at once, comes out whole.
  writeFileSync(file, 'stale');
  await Promise.all(Array.from({ length: 8 }, () => services.sshKeys.sync()));
  expect(readFileSync(file, 'utf8')).toBe(whole);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

it('imports the keys agents made in their old folders, once, and without duplicates', async () => {
  const services = await testServices();
  const atlas = randomUUID();
  const zero = randomUUID();
  const id = randomUUID();
  const legacy = earlierKey(atlas, id, 'Deploy');
  // The same key copied into another folder, and an entry a failed generation left behind.
  cpSync(legacy, join(root, zero, '.ssh', 'jian', randomUUID()), { recursive: true });
  mkdirSync(join(root, zero, '.ssh', 'jian', randomUUID()), { recursive: true });

  expect(await importWorkspaceSshKeys(services.store, services.gatewayVault)).toBe(1);
  expect(await importWorkspaceSshKeys(services.store, services.gatewayVault)).toBe(0);

  const [key] = await services.sshKeys.list();
  expect(await services.sshKeys.list()).toHaveLength(1);
  expect(key).toMatchObject({ id, name: 'Deploy', createdAt: '2026-09-01T10:00:00.000Z' });
  expect(key?.publicKey).toBe(readFileSync(join(legacy, 'id_ed25519.pub'), 'utf8').trim());

  // Every agent now reaches it in the shared directory; the old file stayed where it was.
  await services.sshKeys.sync();
  const home = await workspaceHome();
  expect(readFileSync(join(home, '.ssh', 'jian', id, 'id_ed25519'), 'utf8')).toBe(
    readFileSync(join(legacy, 'id_ed25519'), 'utf8'),
  );
  expect(existsSync(join(legacy, 'metadata.json'))).toBe(true);
});

it('does not bring back a removed key from an old folder, nor leave it readable there', async () => {
  const services = await testServices();
  const id = randomUUID();
  const legacy = earlierKey(randomUUID(), id, 'Deploy');
  const kept = earlierKey(randomUUID(), randomUUID(), 'Kept');
  const beside = join(root, randomUUID(), '.ssh', 'jian', 'notes');
  mkdirSync(beside, { recursive: true });

  expect(await importWorkspaceSshKeys(services.store, services.gatewayVault)).toBe(2);

  await services.sshKeys.remove(id);

  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(kept)).toBe(true);
  expect(existsSync(beside)).toBe(true);
  expect(await importWorkspaceSshKeys(services.store, services.gatewayVault)).toBe(0);
  expect((await services.sshKeys.list()).map((key) => key.id)).not.toContain(id);
});

it('imports only from folders named by an id, since the root is every agent’s home', async () => {
  const services = await testServices();
  const id = randomUUID();
  const planted = earlierKey('tasks', id, 'Planted');

  expect(existsSync(planted)).toBe(true);
  expect(await importWorkspaceSshKeys(services.store, services.gatewayVault)).toBe(0);
});
