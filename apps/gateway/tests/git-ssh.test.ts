import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildGitSshCommand, gitSshCommand, listHomeSshIdentities } from '../src/ssh/git-ssh.js';

const roots: string[] = [];

const previous = process.env.JIAN_WORKSPACES;

afterEach(() => {
  if (previous === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previous;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('lists Jian-managed keys under .ssh/jian/<id> for git IdentityFile', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jian-git-ssh-'));
  roots.push(home);
  const ssh = join(home, '.ssh');
  const managed = join(ssh, 'jian', '11111111-1111-4111-8111-111111111111');
  mkdirSync(managed, { recursive: true, mode: 0o700 });
  writeFileSync(join(ssh, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\ntop\n');
  writeFileSync(join(managed, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\njian\n');
  writeFileSync(join(managed, 'id_ed25519.pub'), 'ssh-ed25519 AAAA jian\n');

  const identities = await listHomeSshIdentities(ssh);
  expect(identities).toEqual([join(ssh, 'id_ed25519'), join(managed, 'id_ed25519')]);
});

it('builds GIT_SSH_COMMAND with IdentitiesOnly and the known_hosts of the shared directory', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jian-git-ssh-')));
  roots.push(home);
  process.env.JIAN_WORKSPACES = home;
  const knownHosts = join(home, '.ssh', 'known_hosts');
  const command = await gitSshCommand();

  expect(command).toContain('IdentitiesOnly=yes');
  expect(command).toContain(`UserKnownHostsFile=${knownHosts}`);
  expect(readFileSync(knownHosts, 'utf8')).toContain('github.com ssh-ed25519');

  const key = join(home, '.ssh', 'jian', 'key', 'id_ed25519');
  const rebuilt = buildGitSshCommand({ knownHosts, identities: [key] });
  expect(rebuilt).toContain(`'-i' '${key}'`);
});
