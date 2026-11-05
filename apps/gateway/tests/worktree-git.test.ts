import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localPlace, remotePlace } from '../src/agent/github-git-place.js';
import {
  addWorktree,
  listedWorktrees,
  mergeWorktree,
  removeWorktree,
  sourceOf,
  updateWorktree,
  WorktreeProblem,
  worktreeRoot,
  worktreeState,
} from '../src/worktrees/git.js';
import { randomName } from '../src/worktrees/names.js';

const place = localPlace({ readOnly: [], writable: [] });
let dir: string;

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function repo(name = 'site') {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  run(path, 'init', '-b', 'main');
  run(path, 'config', 'user.name', 'Ana Example');
  run(path, 'config', 'user.email', 'ana@example.test');
  writeFileSync(join(path, 'a.txt'), 'one\n');
  run(path, 'add', '.');
  run(path, 'commit', '-m', 'first');
  return path;
}

function commit(cwd: string, file: string, text: string) {
  writeFileSync(join(cwd, file), text);
  run(cwd, 'add', '.');
  run(cwd, 'commit', '-m', `edit ${file}`);
}

async function started(name = 'site') {
  const source = repo(name);
  const path = join(dir, `${name}-wt`);
  await addWorktree(place, { source, path, branch: 'jian/calm-otter', base: 'main' });
  return { source, path, branch: 'jian/calm-otter', base: 'main' };
}

/** A hook of the repository's own, as the owner's git would run it. */
function hook(source: string, name: string, body: string) {
  const file = join(source, '.git', 'hooks', name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/** Where it was, with no merge left half done. */
function expectUntouched(source: string, head: string) {
  expect(run(source, 'rev-parse', 'HEAD')).toBe(head);
  expect(() => run(source, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
  expect(run(source, 'status', '--porcelain')).toBe('');
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error) => {
      expect(error).toBeInstanceOf(WorktreeProblem);
      return (error as WorktreeProblem).message;
    },
  );

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'jian-worktree-git-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('worktree git', () => {
  it("creates a worktree on its own branch from the source's branch", async () => {
    const { source, path } = await started();

    expect(run(path, 'branch', '--show-current')).toBe('jian/calm-otter');
    expect(await sourceOf(place, source)).toEqual({ top: source, branch: 'main' });
    expect(await listedWorktrees(place, source)).toContain(path);
  });

  it('refuses a folder that is not a repository and a detached HEAD', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    expect(await refusal(sourceOf(place, plain))).toMatch(/not a git repository/i);

    const source = repo();
    run(source, 'checkout', '--detach');
    expect(await refusal(sourceOf(place, source))).toMatch(/detached HEAD: check out a branch/);
  });

  it('counts ahead, behind and uncommitted', async () => {
    const { source, path, base } = await started();
    commit(path, 'b.txt', 'b\n');
    commit(source, 'c.txt', 'c\n');
    writeFileSync(join(path, 'loose.txt'), 'x');

    expect(await worktreeState(place, { path, base })).toEqual({
      ahead: 1,
      behind: 1,
      uncommitted: 1,
    });
  });

  it('update brings the base in and lists conflicts left in the worktree', async () => {
    const { source, path, base } = await started();
    commit(path, 'a.txt', 'worktree\n');
    commit(source, 'a.txt', 'source\n');

    const result = await updateWorktree(place, { path, base, strategy: 'merge' });
    expect(result.conflicts).toEqual(['a.txt']);
    expect(run(path, 'status', '--porcelain')).toContain('UU a.txt');

    expect(await refusal(updateWorktree(place, { path, base, strategy: 'rebase' }))).toMatch(
      /uncommitted|commit/i,
    );
  });

  it('update merges or rebases cleanly', async () => {
    const one = await started('one');
    commit(one.path, 'b.txt', 'b\n');
    commit(one.source, 'c.txt', 'c\n');
    expect(await updateWorktree(place, { ...one, strategy: 'rebase' })).toEqual({ conflicts: [] });
    expect((await worktreeState(place, one)).behind).toBe(0);
  });

  it('merge refuses when the worktree or the source has changes', async () => {
    const t = await started();
    writeFileSync(join(t.path, 'loose.txt'), 'x');
    expect(await refusal(mergeWorktree(place, t))).toMatch(/worktree.*commit|commit.*worktree/i);

    rmSync(join(t.path, 'loose.txt'));
    writeFileSync(join(t.source, 'a.txt'), 'dirty\n');
    expect(await refusal(mergeWorktree(place, t))).toMatch(/source.*(commit|stash)/i);
  });

  it('tells a subagent merging back to commit in the conversation’s worktree, not the owner', async () => {
    const t = await started();
    writeFileSync(join(t.source, 'a.txt'), 'dirty\n');

    const message = await refusal(mergeWorktree(place, { ...t, into: 'worktree' }));

    expect(message).toContain(`The conversation's worktree at ${t.source} has uncommitted changes`);
    expect(message).toContain('Commit them there');
    expect(message).not.toContain('owner');
  });

  it('merge refuses when the source is on another branch, naming both', async () => {
    const t = await started();
    run(t.source, 'checkout', '-b', 'other');
    const message = await refusal(mergeWorktree(place, t));
    expect(message).toContain('other');
    expect(message).toContain('main');
    expect(run(t.source, 'branch', '--show-current')).toBe('other');
  });

  it('merge refuses when the branch lacks the base and says to update', async () => {
    const t = await started();
    commit(t.path, 'b.txt', 'b\n');
    commit(t.source, 'c.txt', 'c\n');
    expect(await refusal(mergeWorktree(place, t))).toContain('update_worktree');
  });

  it('a merge after update never leaves the source mid-merge', async () => {
    const t = await started();
    commit(t.path, 'b.txt', 'b\n');
    commit(t.source, 'c.txt', 'c\n');
    await updateWorktree(place, { ...t, strategy: 'merge' });

    const { sha } = await mergeWorktree(place, t);
    expect(sha).toBe(run(t.source, 'rev-parse', 'HEAD'));
    expect(() => run(t.source, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow();
    expect(run(t.source, 'status', '--porcelain')).toBe('');
    expect(run(t.source, 'show', '--format=%P', '-s', 'HEAD').split(' ')).toHaveLength(2);
  });

  it('a merge a hook refuses is undone and says what to do next', async () => {
    const t = await started();
    commit(t.path, 'b.txt', 'b\n');
    const before = run(t.source, 'rev-parse', 'HEAD');
    hook(t.source, 'pre-merge-commit', 'echo "lint failed in b.txt" >&2\nexit 1');

    const message = await refusal(mergeWorktree(place, t));

    expect(message).toContain('lint failed in b.txt');
    expect(message).toMatch(/undone/);
    expect(message).toMatch(/commit .*merge again/i);
    expect(message).not.toContain("use 'git commit'");
    expectUntouched(t.source, before);
  });

  it('a merge stopped by the timeout is undone', async () => {
    const t = await started();
    commit(t.path, 'b.txt', 'b\n');
    const before = run(t.source, 'rev-parse', 'HEAD');
    hook(t.source, 'pre-merge-commit', 'sleep 2');

    const message = await refusal(
      mergeWorktree(localPlace({ readOnly: [], writable: [] }, 300), t),
    );

    expect(message).toMatch(/too long/);
    expect(message).toMatch(/undone/);
    expectUntouched(t.source, before);
  });

  it('a merge whose answer is lost is undone when it stopped, and kept when it went through', async () => {
    const lost = (args: string[]) => args.includes('--no-ff');
    // The worker ran the command, then its answer never came back.
    const flaky: typeof place = {
      ...place,
      git: async (args, config, signal) => {
        const outcome = await place.git(args, config, signal);
        if (lost(args)) throw new Error('the machine went offline');
        return outcome;
      },
    };
    const refused = await started('refused');
    commit(refused.path, 'b.txt', 'b\n');
    const before = run(refused.source, 'rev-parse', 'HEAD');
    hook(refused.source, 'pre-merge-commit', 'exit 1');
    expect(await refusal(mergeWorktree(flaky, refused))).toMatch(/undone/);
    expectUntouched(refused.source, before);

    const done = await started('done');
    commit(done.path, 'b.txt', 'b\n');
    const { sha } = await mergeWorktree(flaky, done);
    expect(sha).toBe(run(done.source, 'rev-parse', 'HEAD'));
    expect(run(done.source, 'show', '--format=%P', '-s', 'HEAD').split(' ')).toHaveLength(2);
  });

  it('never aborts a merge that is not its own', async () => {
    const t = await started();
    commit(t.path, 'b.txt', 'b\n');
    run(t.source, 'checkout', '-q', '-b', 'theirs', 'HEAD');
    commit(t.source, 'a.txt', 'theirs\n');
    run(t.source, 'checkout', '-q', 'main');
    commit(t.source, 'a.txt', 'ours\n');
    await updateWorktree(place, { ...t, strategy: 'merge' });
    const theirs = run(t.source, 'rev-parse', 'theirs');
    // Someone else starts a merge of their own just before this one runs, and it stops on a
    // conflict: the merge that fails next is this one, and theirs must stay as it is.
    const crowded: typeof place = {
      ...place,
      git: async (args, config, signal) => {
        if (args.includes('--no-ff')) expect(() => run(t.source, 'merge', 'theirs')).toThrow();
        return place.git(args, config, signal);
      },
    };

    await refusal(mergeWorktree(crowded, t));

    expect(run(t.source, 'rev-parse', 'MERGE_HEAD')).toBe(theirs);
    expect(run(t.source, 'status', '--porcelain')).toContain('UU a.txt');
  });

  it('remove refuses uncommitted work unless discarded', async () => {
    const t = await started();
    writeFileSync(join(t.path, 'loose.txt'), 'x');
    const base = { ...t, discard: false, deleteBranch: false };

    expect(await refusal(removeWorktree(place, base))).toMatch(/discard/i);
    await removeWorktree(place, { ...base, discard: true });
    expect(await listedWorktrees(place, t.source)).not.toContain(t.path);
  });

  it('remove keeps an unmerged branch and deletes a merged one', async () => {
    const kept = await started('kept');
    commit(kept.path, 'b.txt', 'b\n');
    const args = (t: typeof kept) => ({ ...t, discard: false, deleteBranch: false });
    const force = await started('forced');
    commit(force.path, 'b.txt', 'b\n');
    expect(await removeWorktree(place, { ...args(force), deleteBranch: true })).toEqual({
      branchKept: false,
    });
    expect(run(force.source, 'branch', '--list', 'jian/calm-otter')).toBe('');

    expect(await removeWorktree(place, args(kept))).toEqual({ branchKept: true });
    expect(run(kept.source, 'branch', '--list', 'jian/calm-otter')).not.toBe('');

    const merged = await started('merged');
    commit(merged.path, 'b.txt', 'b\n');
    await mergeWorktree(place, merged);
    expect(await removeWorktree(place, args(merged))).toEqual({ branchKept: false });
    expect(run(merged.source, 'branch', '--list', 'jian/calm-otter')).toBe('');
  });

  it('handles paths with spaces and accents', async () => {
    const source = repo(join('Meus Projetos', 'café'));
    const root = await worktreeRoot(place, source);
    const path = `${root}/calm-otter`;
    const t = { source, path, branch: 'jian/calm-otter', base: 'main' };

    await addWorktree(place, t);
    commit(path, 'b.txt', 'b\n');
    expect(await worktreeState(place, t)).toMatchObject({ ahead: 1, uncommitted: 0 });
    await mergeWorktree(place, t);
    await removeWorktree(place, { ...t, discard: false, deleteBranch: false });
    rmSync(root, { recursive: true, force: true });
  });

  it('deletes a merged branch that was pushed with an upstream, without throwing', async () => {
    const t = await started();
    const remote = join(dir, 'remote.git');
    run(dir, 'init', '--bare', '-b', 'main', remote);
    run(t.source, 'remote', 'add', 'origin', remote);
    run(t.source, 'push', '-u', 'origin', 'main');
    commit(t.path, 'b.txt', 'b\n');
    run(t.path, 'push', '-u', 'origin', t.branch);
    commit(t.path, 'c.txt', 'c\n');
    await mergeWorktree(place, t);

    expect(await removeWorktree(place, { ...t, discard: false, deleteBranch: false })).toEqual({
      branchKept: false,
    });
    expect(await listedWorktrees(place, t.source)).not.toContain(t.path);
  });

  it('keeps a home behind a symlink matching what git lists', async () => {
    const real = join(dir, 'real-home');
    mkdirSync(real);
    symlinkSync(real, join(dir, 'link-home'));
    const previous = process.env.JIAN_WORKSPACES;
    process.env.JIAN_WORKSPACES = join(dir, 'link-home', 'ws');
    try {
      const source = repo();
      const wt = join(await worktreeRoot(place, source), 'calm-otter');
      await addWorktree(place, { source, path: wt, branch: 'jian/calm-otter', base: 'main' });
      expect(await listedWorktrees(place, source)).toContain(wt);
    } finally {
      if (previous === undefined) delete process.env.JIAN_WORKSPACES;
      else process.env.JIAN_WORKSPACES = previous;
    }
  });

  it('worktreeRoot is stable and keyed by the source path', async () => {
    const a = await worktreeRoot(place, '/x/site');
    expect(a).toMatch(/\/worktrees\/site-[0-9a-f]{8}$/);
    expect(await worktreeRoot(place, '/x/site')).toBe(a);
    expect(await worktreeRoot(place, '/y/site')).not.toBe(a);
  });

  it('home on a machine is the worker home plus Jian, by platform', async () => {
    const calls: string[] = [];
    const fake = (platform: string, stdout: string) =>
      remotePlace('p', 'm', {
        list: async () => [{ id: 'm', name: 'Box', online: true, platform }] as never,
        execute: (async (_p: string, _m: string, input: { command: string }) => {
          calls.push(input.command);
          return { exitCode: 0, stdout, stderr: '', timedOut: false };
        }) as never,
      });

    expect(await fake('linux', '/home/ana').home()).toBe('/home/ana/Jian');
    expect(await fake('win32', 'C:\\Users\\ana\n').home()).toBe('C:/Users/ana/Jian');
    expect(calls[0]).toContain('$HOME');
    expect(calls[1]).toContain('USERPROFILE');
  });
});

describe('randomName', () => {
  it('redraws taken names, then numbers them', async () => {
    const draws = [0, 0, 0.5, 0.5];
    let i = 0;
    const random = () => draws[i++ % draws.length] ?? 0;
    const first = await randomName(() => false, random);
    expect(first).toMatch(/^[a-z]+-[a-z]+$/);

    i = 0;
    const second = await randomName((name) => name === first, random);
    expect(second).not.toBe(first);

    const crowded = await randomName(
      (name) => !/-\d+$/.test(name),
      () => 0,
    );
    expect(crowded).toMatch(/^[a-z]+-[a-z]+-2$/);
    const more = await randomName(
      (name) => !/-3$/.test(name),
      () => 0,
    );
    expect(more).toMatch(/-3$/);
  });
});
