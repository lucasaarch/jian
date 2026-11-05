import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionChangesSchema } from '@jian/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { projectCheckout } from '../src/agent/workspace-home.js';
import { createApp } from '../src/app.js';
import { checkoutChanges } from '../src/sessions/changes.js';
import { projects, sessionWorktrees } from '../src/storage/schema.js';
import { git } from './helpers/git-server.js';
import { testServices } from './helpers/services.js';

const root = mkdtempSync(join(tmpdir(), 'jian-changes-'));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;
afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

function repository() {
  const dir = mkdtempSync(join(root, 'checkout-'));
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'modified.txt'), 'before\n');
  writeFileSync(join(dir, 'deleted.txt'), 'remove\n');
  writeFileSync(join(dir, 'renamed.txt'), 'same\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'Initial');
  return dir;
}

const diffOf = async (dir: string, path: string) => {
  const result = await checkoutChanges(dir, path);
  expect(sessionChangesSchema.safeParse(result).success).toBe(true);
  return result.files[0];
};

describe('current project checkout changes', () => {
  it('hands over the file as it is now only when asked, and no file for a deleted one', async () => {
    const dir = repository();
    writeFileSync(join(dir, 'modified.txt'), 'one\r\ntwo\n');
    unlinkSync(join(dir, 'deleted.txt'));

    expect((await checkoutChanges(dir, 'modified.txt')).files[0]?.lines).toBeUndefined();
    const whole = await checkoutChanges(dir, 'modified.txt', true);
    expect(sessionChangesSchema.safeParse(whole).success).toBe(true);
    expect(whole.files[0]?.lines).toEqual(['one', 'two']);
    expect((await checkoutChanges(dir, 'deleted.txt', true)).files[0]?.lines).toBeUndefined();
    // The route takes the same path as a diff: a file not changed is still not readable.
    await expect(checkoutChanges(dir, '../outside.txt', true)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('lists staged, unstaged, deleted, renamed and untracked files; diffs current contents against HEAD without writes', async () => {
    const dir = repository();
    writeFileSync(join(dir, 'modified.txt'), 'staged\n');
    git(dir, 'add', 'modified.txt');
    writeFileSync(join(dir, 'modified.txt'), 'current\n');
    unlinkSync(join(dir, 'deleted.txt'));
    renameSync(join(dir, 'renamed.txt'), join(dir, 'new name.txt'));
    git(dir, 'add', 'renamed.txt', 'new name.txt');
    writeFileSync(join(dir, 'added.txt'), 'added\n');
    git(dir, 'add', 'added.txt');
    const unusual = "--literal [x] 'quoted'\nfile.txt";
    writeFileSync(join(dir, unusual), 'untracked\n');
    const index = readFileSync(join(dir, '.git/index'));
    const beforeStatus = git(dir, '--no-optional-locks', 'status', '--porcelain=v1', '-z');
    const changes = await checkoutChanges(dir);
    expect(changes.truncated).toBe(false);
    expect(new Map(changes.files.map((file) => [file.path, file.status]))).toEqual(
      new Map([
        ['modified.txt', 'modified'],
        ['deleted.txt', 'deleted'],
        ['new name.txt', 'renamed'],
        ['added.txt', 'added'],
        [unusual, 'untracked'],
      ]),
    );
    expect(changes.files.every((file) => !file.diff)).toBe(true);
    expect((await diffOf(dir, 'modified.txt'))?.diff?.hunks[0]?.lines).toEqual([
      { kind: 'del', old: 1, text: 'before' },
      { kind: 'add', new: 1, text: 'current' },
    ]);
    expect((await diffOf(dir, 'deleted.txt'))?.diff).toMatchObject({ deletions: 1, additions: 0 });
    expect(await diffOf(dir, 'new name.txt')).toMatchObject({
      previousPath: 'renamed.txt',
      unavailable: expect.stringContaining('No text diff'),
    });
    expect((await diffOf(dir, 'added.txt'))?.diff).toMatchObject({ created: true, additions: 1 });
    expect((await diffOf(dir, unusual))?.diff).toMatchObject({ path: unusual, created: true });
    expect(readFileSync(join(dir, '.git/index'))).toEqual(index);
    expect(git(dir, '--no-optional-locks', 'status', '--porcelain=v1', '-z')).toBe(beforeStatus);
    expect(readFileSync(join(dir, 'modified.txt'), 'utf8')).toBe('current\n');
  });

  it('handles an unborn repository and does not duplicate staged deletions replaced by untracked files', async () => {
    const unborn = mkdtempSync(join(root, 'unborn-'));
    git(unborn, 'init', '-q');
    writeFileSync(join(unborn, 'new.txt'), 'new\n');
    git(unborn, 'add', '.');
    expect((await diffOf(unborn, 'new.txt'))?.diff).toMatchObject({ created: true, additions: 1 });
    const dir = repository();
    git(dir, 'rm', '--cached', 'modified.txt');
    writeFileSync(join(dir, 'modified.txt'), 'replacement\n');
    expect(
      (await checkoutChanges(dir)).files.filter((file) => file.path === 'modified.txt'),
    ).toHaveLength(1);
    expect((await diffOf(dir, 'modified.txt'))?.diff).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('rejects arbitrary paths, parent checkouts, symlinks and binary/oversized content', async () => {
    const dir = repository();
    await expect(checkoutChanges(dir, '../outside.txt')).rejects.toMatchObject({ statusCode: 404 });
    await expect(checkoutChanges(dir, '.git/config')).rejects.toMatchObject({ statusCode: 404 });
    await expect(checkoutChanges(dir, ':(glob)**')).rejects.toMatchObject({ statusCode: 404 });
    mkdirSync(join(dir, 'nested'));
    await expect(checkoutChanges(join(dir, 'nested'))).rejects.toMatchObject({ statusCode: 409 });
    writeFileSync(join(root, 'outside.txt'), 'not for this checkout');
    symlinkSync(join(root, 'outside.txt'), join(dir, 'link.txt'));
    writeFileSync(join(dir, 'binary.bin'), Buffer.from([0, 1, 2]));
    writeFileSync(join(dir, 'large.txt'), 'x'.repeat(500_001));
    expect((await diffOf(dir, 'link.txt'))?.unavailable).toContain('Symlinks');
    expect((await diffOf(dir, 'binary.bin'))?.unavailable).toContain('Binary');
    expect((await diffOf(dir, 'large.txt'))?.unavailable).toContain('too large');
  });

  it('does not run a configured transport when a partial clone is missing the committed blob', async () => {
    const dir = repository();
    const blob = git(dir, 'rev-parse', 'HEAD:modified.txt');
    const marker = join(dir, 'LAZY_FETCHED');
    const command = `echo touched >> "${marker}"`;
    git(dir, 'config', 'core.repositoryFormatVersion', '1');
    git(dir, 'config', 'extensions.partialClone', 'origin');
    git(dir, 'config', 'remote.origin.promisor', 'true');
    git(dir, 'config', 'remote.origin.partialclonefilter', 'blob:none');
    git(dir, 'config', 'remote.origin.url', 'ssh://example.invalid/repo.git');
    git(dir, 'config', 'core.sshCommand', command);
    unlinkSync(join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    writeFileSync(join(dir, 'modified.txt'), 'changed\n');

    // Prove this repository really would invoke its configured transport on an ordinary lazy fetch.
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
    expect(() =>
      execFileSync('git', ['show', 'HEAD:modified.txt'], { cwd: dir, env, stdio: 'ignore' }),
    ).toThrow();
    expect(existsSync(marker)).toBe(true);
    unlinkSync(marker);

    await checkoutChanges(dir, 'modified.txt').then(
      (result) => expect(result.files[0]?.unavailable).toBeTruthy(),
      (error: unknown) => expect(error).toMatchObject({ statusCode: 409 }),
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('does not execute repository-supplied clean filters, fsmonitor, external diff or textconv', async () => {
    const dir = repository();
    const marker = join(dir, 'EXECUTED');
    const command = `touch '${marker}'`;
    writeFileSync(join(dir, '.gitattributes'), '*.txt filter=unsafe diff=unsafe\n');
    git(dir, 'config', 'filter.unsafe.clean', command);
    git(dir, 'config', 'filter.unsafe.process', command);
    git(dir, 'config', 'filter.unsafe.required', 'true');
    git(dir, 'config', 'diff.external', command);
    git(dir, 'config', 'diff.unsafe.textconv', command);
    git(dir, 'config', 'core.fsmonitor', command);
    writeFileSync(join(dir, 'modified.txt'), 'changed\n');
    expect((await diffOf(dir, 'modified.txt'))?.diff).toMatchObject({ additions: 1, deletions: 1 });
    expect(existsSync(marker)).toBe(false);
  });

  it('caps the list explicitly and still allows a listed path beyond the first page to be diffed', async () => {
    const dir = repository();
    for (let index = 0; index < 2001; index += 1)
      writeFileSync(join(dir, `untracked-${index}.txt`), 'new\n');
    const changes = await checkoutChanges(dir);
    expect(changes.files).toHaveLength(2000);
    expect(changes.truncated).toBe(true);
    expect((await diffOf(dir, 'untracked-999.txt'))?.diff?.created).toBe(true);
  });

  it('requires owner authentication and an own single-project session before reading its checkout', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
    const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
    const projectId = randomUUID();
    await services.store.db.insert(projects).values({
      id: projectId,
      profileId: profile.id,
      name: 'example/site',
      repositoryUrl: 'https://example.test/site.git',
    });
    const session = await services.sessions.createGatewaySession(profile.id, { projectId });
    const token = 'synthetic-admin-token-with-32-characters';
    const app = createApp({ ...services, token, logger: false });
    const url = `/v1/profiles/${profile.id}/sessions/${session.id}/changes`;
    try {
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect(
        (await app.inject({ url, headers: { authorization: `Bearer ${token}` } })).statusCode,
      ).toBe(409);
      await expect(services.sessions.changes(other.id, session.id)).rejects.toMatchObject({
        statusCode: 404,
      });
      const ordinary = await services.sessions.createGatewaySession(profile.id, {});
      await expect(services.sessions.changes(profile.id, ordinary.id)).rejects.toMatchObject({
        statusCode: 409,
      });
      const checkout = await projectCheckout(profile.id, projectId, session.id);
      mkdirSync(checkout, { recursive: true });
      git(checkout, 'init', '-q');
      writeFileSync(join(checkout, 'fresh.txt'), 'fresh\n');
      const response = await app.inject({
        url: `${url}?path=fresh.txt`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        files: [{ path: 'fresh.txt', diff: { created: true } }],
        truncated: false,
      });
      const machine = await services.remote.create({ name: 'Test machine' });
      await services.sessions.setGatewayTarget(profile.id, session.id, {
        projectId,
        remoteMachineId: machine.id,
      });
      // A real local checkout must never become a fallback for a remote conversation.
      await expect(services.sessions.changes(profile.id, session.id)).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("on the conversation's machine"),
      });
      const secondId = randomUUID();
      await services.store.db.insert(projects).values({
        id: secondId,
        profileId: profile.id,
        name: 'example/second',
        repositoryUrl: 'https://example.test/second.git',
      });
      const multiple = await services.sessions.createGatewaySession(profile.id, {
        projectIds: [projectId, secondId],
      });
      await expect(services.sessions.changes(profile.id, multiple.id)).rejects.toMatchObject({
        statusCode: 409,
      });
    } finally {
      await app.close();
    }
  });
});

describe("a worktree's changes", () => {
  async function worktreeConversation() {
    const services = await testServices();
    const profile = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
    const session = await services.sessions.createGatewaySession(profile.id, {});
    const source = repository();
    git(source, 'branch', '-M', 'main');
    const place = (name: string, sessionId = session.id, folder = source) => {
      const path = join(root, 'worktrees', `${name}-${randomUUID().slice(0, 8)}`);
      git(folder, 'branch', '-M', 'main');
      git(folder, 'worktree', 'add', '-q', '-b', `jian/${name}`, path);
      return services.store.db
        .insert(sessionWorktrees)
        .values({
          id: randomUUID(),
          profileId: profile.id,
          sessionId,
          name,
          branch: `jian/${name}`,
          base: 'main',
          source: folder,
          path,
          place: 'gateway',
        })
        .then(() => path);
    };
    return { services, profile, session, source, place };
  }

  it('include its commits and uncommitted files against the merge base', async () => {
    const { services, profile, session, source, place } = await worktreeConversation();
    const path = await place('calm-otter');
    git(path, 'config', 'user.email', 'ana@example.test');
    git(path, 'config', 'user.name', 'Ana');
    writeFileSync(join(path, 'committed.txt'), 'in a commit\n');
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'Add committed');
    writeFileSync(join(path, 'modified.txt'), 'edited\n');
    unlinkSync(join(path, 'deleted.txt'));
    writeFileSync(join(path, 'loose.txt'), 'untracked\n');
    // The base moves on after the branch was made: its new file is not the worktree's work.
    writeFileSync(join(source, 'elsewhere.txt'), 'base work\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'Base moves on');

    const changes = await services.sessions.changes(profile.id, session.id);
    expect(new Map(changes.files.map((file) => [file.path, file.status]))).toEqual(
      new Map([
        ['committed.txt', 'added'],
        ['modified.txt', 'modified'],
        ['deleted.txt', 'deleted'],
        ['loose.txt', 'untracked'],
      ]),
    );
    const diff = await services.sessions.changes(profile.id, session.id, { path: 'modified.txt' });
    expect(sessionChangesSchema.safeParse(diff).success).toBe(true);
    expect(diff.files[0]?.diff).toMatchObject({ additions: 1, deletions: 1 });
    const committed = await services.sessions.changes(profile.id, session.id, {
      path: 'committed.txt',
    });
    expect(committed.files[0]?.diff).toMatchObject({ created: true, additions: 1 });
  });

  it("never read the source or another conversation's worktree", async () => {
    const { services, profile, session, source, place } = await worktreeConversation();
    const other = await services.sessions.createGatewaySession(profile.id, {});
    const theirs = await place('quiet-fox', other.id);
    writeFileSync(join(theirs, 'private.txt'), 'theirs\n');
    writeFileSync(join(source, 'in-source.txt'), 'source\n');

    // Nothing of its own: the existing refusal, not their checkout and not the source.
    await expect(services.sessions.changes(profile.id, session.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      services.sessions.changes(profile.id, session.id, { worktree: 'quiet-fox' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const mine = await place('calm-otter', session.id, repository());
    writeFileSync(join(mine, 'mine.txt'), 'mine\n');
    const changes = await services.sessions.changes(profile.id, session.id);
    expect(changes.files.map((file) => file.path)).toEqual(['mine.txt']);
  });

  it('need ?worktree= when there are several', async () => {
    const { services, profile, session, place } = await worktreeConversation();
    await place('calm-otter');
    const second = await place('quiet-fox', session.id, repository());
    writeFileSync(join(second, 'second.txt'), 'second\n');

    await expect(services.sessions.changes(profile.id, session.id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Choose a worktree'),
    });
    const named = await services.sessions.changes(profile.id, session.id, {
      worktree: 'quiet-fox',
    });
    expect(named.files.map((file) => file.path)).toEqual(['second.txt']);
  });
});
