import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  ensureTrustedKnownHosts,
  TRUSTED_SSH_HOST_KEYS,
  trustedKnownHostLines,
} from '../src/ssh/known-hosts.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('seeds GitHub’s published host keys into an empty known_hosts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jian-known-hosts-'));
  roots.push(home);

  const path = await ensureTrustedKnownHosts(home);
  const text = readFileSync(path, 'utf8');

  for (const line of trustedKnownHostLines()) {
    expect(text).toContain(line);
  }
  expect(text).toContain('github.com ssh-ed25519');
  expect(Object.keys(TRUSTED_SSH_HOST_KEYS)).toContain('ssh.github.com');
});

it('preserves operator-added hosts and does not duplicate seeded lines', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jian-known-hosts-'));
  roots.push(home);
  mkdirSync(join(home, '.ssh'), { mode: 0o700 });
  const path = join(home, '.ssh', 'known_hosts');
  writeFileSync(path, 'bitbucket.org synthetic-host-key\n');

  await ensureTrustedKnownHosts(home);
  await ensureTrustedKnownHosts(home);
  const text = readFileSync(path, 'utf8');

  expect(text).toContain('bitbucket.org synthetic-host-key');
  expect(text.match(/^github\.com ssh-ed25519 /gm)).toHaveLength(1);
});
