import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SESSION_FILE_MAX_BYTES,
  type SessionFile,
  type SessionFiles,
  sessionFileSchema,
  sessionFilesSchema,
} from '@jian/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { projectCheckout, sessionCheckouts } from '../src/agent/workspace-home.js';
import { createApp } from '../src/app.js';
import { projects, sessionWorktrees } from '../src/storage/schema.js';
import { git } from './helpers/git-server.js';
import { testServices } from './helpers/services.js';

const root = mkdtempSync(join(tmpdir(), 'jian-files-'));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;
afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

const token = 'synthetic-admin-token-with-32-characters';
const headers = { authorization: `Bearer ${token}` };

/** A checkout with one commit: two tracked files and an ignore rule. */
function checkoutAt(dir: string) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, '.gitignore'), 'ignored/\n*.log\n');
  writeFileSync(join(dir, 'README.md'), '# Site\n');
  writeFileSync(join(dir, 'src/index.ts'), 'export const one = 1;\n');
  writeFileSync(join(dir, 'src/old.ts'), 'export const old = 0;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'Initial');
}

async function world() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const app = createApp({ ...services, token, logger: false });
  const project = async (name: string) => {
    const id = randomUUID();
    await services.store.db.insert(projects).values({
      id,
      profileId: profile.id,
      name: `example/${name}`,
      repositoryUrl: `https://example.test/example/${name}.git`,
    });
    return id;
  };
  const at = (sessionId: string, profileId = profile.id) =>
    `/v1/profiles/${profileId}/sessions/${sessionId}/files`;
  const list = async (sessionId: string) => {
    const response = await app.inject({ url: at(sessionId), headers });
    expect(response.statusCode).toBe(200);
    return sessionFilesSchema.parse(response.json()) as SessionFiles;
  };
  const read = (sessionId: string, rootId: string, path: string) =>
    app.inject({ url: `${at(sessionId)}/content`, query: { root: rootId, path }, headers });
  const file = async (sessionId: string, rootId: string, path: string) => {
    const response = await read(sessionId, rootId, path);
    expect(response.statusCode).toBe(200);
    return sessionFileSchema.parse(response.json()) as SessionFile;
  };
  return { services, profile, app, project, at, list, read, file };
}

describe("a conversation's files", () => {
  it('are for the owner alone, and only of a conversation of that agent with a project', async () => {
    const { services, profile, app, project, at } = await world();
    try {
      const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
      const projectId = await project('site');
      const session = await services.sessions.createGatewaySession(profile.id, { projectId });
      checkoutAt(await projectCheckout(profile.id, projectId, session.id));
      const content = `${at(session.id)}/content?root=${projectId}&path=README.md`;

      expect((await app.inject({ url: at(session.id) })).statusCode).toBe(401);
      expect((await app.inject({ url: content })).statusCode).toBe(401);
      expect((await app.inject({ url: content, headers })).statusCode).toBe(200);
      // The same conversation asked for through another agent does not exist.
      const theirs = at(session.id, other.id);
      expect((await app.inject({ url: theirs, headers })).statusCode).toBe(404);
      expect(
        (await app.inject({ url: `${theirs}/content?root=${projectId}&path=README.md`, headers }))
          .statusCode,
      ).toBe(404);

      const plain = await services.sessions.createGatewaySession(profile.id, {});
      expect((await app.inject({ url: at(plain.id), headers })).statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('list tracked and untracked files, leave out ignored ones, and mark what changed', async () => {
    const { services, profile, app, project, list, file } = await world();
    try {
      const projectId = await project('site');
      const session = await services.sessions.createGatewaySession(profile.id, { projectId });

      // Before the agent cloned it: the root is there, and says why it is empty.
      const before = await list(session.id);
      expect(before.roots).toMatchObject([{ id: projectId, name: 'example/site', files: [] }]);
      expect(before.roots[0]?.unavailable).toBeTruthy();

      const dir = await projectCheckout(profile.id, projectId, session.id);
      checkoutAt(dir);
      writeFileSync(join(dir, 'src/index.ts'), 'export const one = 2;\n');
      unlinkSync(join(dir, 'src/old.ts'));
      writeFileSync(join(dir, 'src/new file.ts'), 'export {};\n');
      mkdirSync(join(dir, 'ignored'));
      writeFileSync(join(dir, 'ignored/secret.txt'), 'kept out\n');
      writeFileSync(join(dir, 'debug.log'), 'kept out\n');
      // A filter or fsmonitor of the repository's must not run for a listing.
      const marker = join(dir, 'EXECUTED');
      git(dir, 'config', 'core.fsmonitor', `touch '${marker}'`);
      git(dir, 'config', 'filter.unsafe.clean', `touch '${marker}'`);
      const index = readFileSync(join(dir, '.git/index'));

      const [only, ...rest] = (await list(session.id)).roots;
      expect(rest).toEqual([]);
      expect(only?.unavailable).toBeUndefined();
      expect(only?.truncated).toBe(false);
      expect([...(only?.files ?? [])].sort()).toEqual([
        '.gitignore',
        'README.md',
        'src/index.ts',
        'src/new file.ts',
        'src/old.ts',
      ]);
      expect(new Map(only?.changes.map((change) => [change.path, change.status]))).toEqual(
        new Map([
          ['src/index.ts', 'modified'],
          ['src/old.ts', 'deleted'],
          ['src/new file.ts', 'untracked'],
        ]),
      );
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(join(dir, '.git/index'))).toEqual(index);

      // What is on disk now, not what was committed.
      expect(await file(session.id, projectId, 'src/index.ts')).toEqual({
        root: projectId,
        path: 'src/index.ts',
        size: 22,
        text: 'export const one = 2;\n',
      });
      expect((await file(session.id, projectId, 'src/new file.ts')).text).toBe('export {};\n');
    } finally {
      await app.close();
    }
  });

  it('never leave the checkout: no parent path, absolute path, git internals or link out', async () => {
    const { services, profile, app, project, read, file } = await world();
    try {
      const projectId = await project('site');
      const session = await services.sessions.createGatewaySession(profile.id, { projectId });
      const dir = await projectCheckout(profile.id, projectId, session.id);
      checkoutAt(dir);
      const outside = join(root, `outside-${randomUUID()}.txt`);
      writeFileSync(outside, 'not of this checkout\n');
      symlinkSync(outside, join(dir, 'link-out.txt'));
      symlinkSync(join(dir, 'README.md'), join(dir, 'link-in.md'));
      symlinkSync(root, join(dir, 'folder-out'));

      for (const path of [
        '../outside.txt',
        `src/../../${outside.split('/').pop()}`,
        outside,
        '/etc/hostname',
        '.git/config',
        'src/.GIT/config',
        'src',
        'missing.txt',
        './README.md',
      ]) {
        expect([path, (await read(session.id, projectId, path)).statusCode]).toEqual([path, 404]);
      }
      // A root is one of this conversation's, never a path or another project.
      for (const rootId of [dir, randomUUID(), 'worktree:calm-otter']) {
        expect((await read(session.id, rootId, 'README.md')).statusCode).toBe(404);
      }

      const out = await file(session.id, projectId, 'link-out.txt');
      expect(out.text).toBeUndefined();
      expect(out.unavailable).toContain('outside');
      const through = await file(session.id, projectId, `folder-out/${outside.split('/').pop()}`);
      expect(through.text).toBeUndefined();
      expect(through.unavailable).toContain('outside');
      // A link that stays inside reads as the file it points at.
      expect((await file(session.id, projectId, 'link-in.md')).text).toBe('# Site\n');
    } finally {
      await app.close();
    }
  });

  it('say why a binary or oversized file is not shown, with its size', async () => {
    const { services, profile, app, project, file } = await world();
    try {
      const projectId = await project('site');
      const session = await services.sessions.createGatewaySession(profile.id, { projectId });
      const dir = await projectCheckout(profile.id, projectId, session.id);
      checkoutAt(dir);
      writeFileSync(join(dir, 'image.bin'), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
      writeFileSync(join(dir, 'large.txt'), 'x'.repeat(SESSION_FILE_MAX_BYTES + 1));
      writeFileSync(join(dir, 'full.txt'), 'y'.repeat(SESSION_FILE_MAX_BYTES));
      writeFileSync(join(dir, 'accents.txt'), 'coração\n');

      const binary = await file(session.id, projectId, 'image.bin');
      expect(binary).toMatchObject({ size: 7, unavailable: expect.stringContaining('binary') });
      expect(binary.text).toBeUndefined();
      const large = await file(session.id, projectId, 'large.txt');
      expect(large).toMatchObject({
        size: SESSION_FILE_MAX_BYTES + 1,
        unavailable: expect.stringContaining('too large'),
      });
      expect(large.text).toBeUndefined();
      expect((await file(session.id, projectId, 'full.txt')).text).toHaveLength(
        SESSION_FILE_MAX_BYTES,
      );
      expect(await file(session.id, projectId, 'accents.txt')).toMatchObject({
        size: Buffer.byteLength('coração\n'),
        text: 'coração\n',
      });
    } finally {
      await app.close();
    }
  });

  it('come from each project of a conversation on several, and from none of another', async () => {
    const { services, profile, app, project, list, read, file } = await world();
    try {
      const site = await project('site');
      const api = await project('api');
      const elsewhere = await project('elsewhere');
      const session = await services.sessions.createGatewaySession(profile.id, {
        projectIds: [site, api],
      });
      const checkouts = await sessionCheckouts(profile.id, session.id);
      checkoutAt(join(checkouts, 'site'));
      checkoutAt(join(checkouts, 'api'));
      writeFileSync(join(checkouts, 'api', 'routes.ts'), 'export {};\n');
      // A loose file beside the checkouts is of neither project.
      writeFileSync(join(checkouts, 'notes.txt'), 'loose\n');

      const { roots } = await list(session.id);
      expect(roots.map((item) => [item.id, item.name])).toEqual([
        [site, 'example/site'],
        [api, 'example/api'],
      ]);
      expect(roots[0]?.files).toContain('README.md');
      expect(roots[0]?.changes).toEqual([]);
      expect(roots[1]?.files).toContain('routes.ts');
      expect(roots[1]?.changes).toEqual([{ path: 'routes.ts', status: 'untracked' }]);
      expect((await file(session.id, api, 'routes.ts')).text).toBe('export {};\n');
      expect((await read(session.id, site, 'routes.ts')).statusCode).toBe(404);
      expect((await read(session.id, site, '../notes.txt')).statusCode).toBe(404);
      expect((await read(session.id, elsewhere, 'README.md')).statusCode).toBe(404);

      // One project not cloned yet does not hide the other.
      const half = await services.sessions.createGatewaySession(profile.id, {
        projectIds: [site, elsewhere],
      });
      checkoutAt(join(await sessionCheckouts(profile.id, half.id), 'site'));
      const partial = (await list(half.id)).roots;
      expect(partial[0]?.files).toContain('README.md');
      expect(partial[1]).toMatchObject({ id: elsewhere, files: [], changes: [] });
      expect(partial[1]?.unavailable).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("are its own worktree's once it has one, with the branch's commits as changes", async () => {
    const { services, profile, app, project, list, read, file } = await world();
    try {
      const projectId = await project('site');
      const session = await services.sessions.createGatewaySession(profile.id, { projectId });
      const source = await projectCheckout(profile.id, projectId, session.id);
      checkoutAt(source);
      const place = async (name: string, sessionId: string) => {
        const path = join(root, 'worktrees', `${name}-${randomUUID().slice(0, 8)}`);
        git(source, 'worktree', 'add', '-q', '-b', `jian/${name}`, path);
        await services.store.db.insert(sessionWorktrees).values({
          id: randomUUID(),
          profileId: profile.id,
          sessionId,
          name,
          branch: `jian/${name}`,
          base: 'main',
          source,
          path,
          place: 'gateway',
        });
        return path;
      };
      const other = await services.sessions.createGatewaySession(profile.id, {});
      const theirs = await place('quiet-fox', other.id);
      writeFileSync(join(theirs, 'private.txt'), 'theirs\n');
      const mine = await place('calm-otter', session.id);
      writeFileSync(join(mine, 'committed.ts'), 'export {};\n');
      git(mine, 'add', '.');
      git(mine, 'commit', '-qm', 'Add a file');
      writeFileSync(join(mine, 'loose.txt'), 'untracked\n');

      const { roots } = await list(session.id);
      expect(roots.map((item) => [item.id, item.name])).toEqual([
        ['worktree:calm-otter', 'calm-otter'],
      ]);
      expect(roots[0]?.files).toEqual(expect.arrayContaining(['committed.ts', 'loose.txt']));
      expect(new Map(roots[0]?.changes.map((change) => [change.path, change.status]))).toEqual(
        new Map([
          ['committed.ts', 'added'],
          ['loose.txt', 'untracked'],
        ]),
      );
      expect((await file(session.id, 'worktree:calm-otter', 'loose.txt')).text).toBe('untracked\n');
      // Another conversation's worktree is not a root here, by name or through the project.
      expect((await read(session.id, 'worktree:quiet-fox', 'private.txt')).statusCode).toBe(404);
      expect((await read(session.id, projectId, 'README.md')).statusCode).toBe(404);
      expect((await list(other.id)).roots.map((item) => item.id)).toEqual(['worktree:quiet-fox']);
    } finally {
      await app.close();
    }
  });

  it('are not read from the gateway for a conversation that works on a machine', async () => {
    const { services, profile, app, project, at, read } = await world();
    try {
      const projectId = await project('site');
      const session = await services.sessions.createGatewaySession(profile.id, { projectId });
      checkoutAt(await projectCheckout(profile.id, projectId, session.id));
      const machine = await services.remote.create({ name: 'Test machine' });
      await services.sessions.setGatewayTarget(profile.id, session.id, {
        projectId,
        remoteMachineId: machine.id,
      });

      // The checkout left on the gateway must not stand in for the machine's.
      const listing = await app.inject({ url: at(session.id), headers });
      expect(listing.statusCode).toBe(409);
      expect(listing.json().error).toContain('on a machine');
      expect((await read(session.id, projectId, 'README.md')).statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});
