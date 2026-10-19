import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  buildGitSshCommand,
  listProfileSshIdentities,
  prepareProfileSshAccess,
} from '../src/ssh/git-ssh.js';

const roots: string[] = [];

afterEach(() => {
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

  const identities = await listProfileSshIdentities(ssh);
  expect(identities).toEqual([join(ssh, 'id_ed25519'), join(managed, 'id_ed25519')]);
});

it('builds GIT_SSH_COMMAND with IdentitiesOnly and the profile known_hosts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jian-git-ssh-'));
  roots.push(home);
  const access = await prepareProfileSshAccess(home);

  expect(access.knownHosts).toBe(join(home, '.ssh', 'known_hosts'));
  expect(access.sshCommand).toContain('IdentitiesOnly=yes');
  expect(access.sshCommand).toContain(`UserKnownHostsFile=${access.knownHosts}`);

  const key = join(home, '.ssh', 'jian', 'key', 'id_ed25519');
  const rebuilt = buildGitSshCommand({
    knownHosts: access.knownHosts,
    identities: [key],
  });
  expect(rebuilt).toContain(`'-i' '${key}'`);
});
