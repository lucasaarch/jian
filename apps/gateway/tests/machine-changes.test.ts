import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteFilesAnswer, RemoteFilesOp } from '@jian/contracts';
import { sessionChangesSchema } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { MachineAnswers } from '../src/sessions/machine-checkout.js';
import { projects, remoteTasks, runs, sessionWorktrees } from '../src/storage/schema.js';
import { git } from './helpers/git-server.js';
import { testServices } from './helpers/services.js';

type Services = Awaited<ReturnType<typeof testServices>>;
type Machine = { id: string; token: string };

const root = mkdtempSync(join(tmpdir(), 'jian-machine-changes-'));
const plain = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** Git's raw output, untrimmed: a leading space in a porcelain record is part of it. */
const raw = (cwd: string, ...args: string[]) => {
  try {
    return { code: 0, stdout: execFileSync('git', args, { cwd, env: plain, encoding: 'utf8' }) };
  } catch (error) {
    return { code: (error as { status?: number }).status ?? 1, stdout: '' };
  }
};

function repository() {
  const dir = mkdtempSync(join(root, 'checkout-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'modified.txt'), 'before\n');
  writeFileSync(join(dir, 'deleted.txt'), 'remove\n');
  writeFileSync(join(dir, 'large.txt'), 'small for now\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'Initial');
  return dir;
}

/**
 * The machine's side, faked (the gateway never imports the worker): it polls like a worker and
 * answers the three git operations by running git on a folder of this computer, which stands
 * for the machine's disk. A path in `tooLarge` answers as a side over the 200,000 bytes would.
 */
function fakeWorker(services: Services, machine: Machine, capabilities = 'files-v1') {
  const ops: RemoteFilesOp[] = [];
  const tooLarge = new Set<string>();
  let stopped = false;
  /** While set, a claimed task is answered only once it resolves: a busy machine. */
  let held: Promise<void> | undefined;

  const answer = (op: RemoteFilesOp): RemoteFilesAnswer => {
    if (op.op === 'git-status') {
      const status = raw(
        op.root,
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=dirty',
      );
      const diff = op.against
        ? raw(op.root, 'diff', '--name-status', '-z', '--no-renames', op.against, '--').stdout
        : undefined;
      return {
        ok: true,
        op: 'git-status',
        top: op.root,
        filters: [],
        status: status.stdout,
        ...(diff === undefined ? {} : { diff }),
      };
    }
    if (op.op === 'git-file') {
      if (tooLarge.has(op.path)) {
        return {
          ok: false,
          op: 'git-file',
          problem: 'too-large',
          message: 'The file is too large to display.',
        };
      }
      const shown = raw(op.root, 'cat-file', 'blob', `${op.against}:${op.path}`);
      const working = join(op.root, op.path);
      return {
        ok: true,
        op: 'git-file',
        before: shown.code === 0 ? shown.stdout : null,
        after: existsSync(working) ? readFileSync(working, 'utf8') : null,
      };
    }
    if (op.op === 'merge-base') {
      const found = raw(op.root, 'merge-base', `refs/heads/${op.base}`, 'HEAD');
      return { ok: true, op: 'merge-base', sha: found.stdout.trim() };
    }
    return { ok: false, op: op.op, problem: 'failed', message: 'Not in this fake.' };
  };

  const loop = (async () => {
    while (!stopped) {
      const { task } = await services.remote.poll(
        machine.id,
        `Bearer ${machine.token}`,
        'linux-x64',
        capabilities,
        'unlocked',
      );
      if (!task) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      if (task.kind !== 'files' || !task.files) {
        await services.remote.complete(machine.id, task.id, `Bearer ${machine.token}`, {
          taskId: task.id,
          exitCode: 1,
          stdout: '',
          stderr: '',
        });
        continue;
      }
      ops.push(task.files);
      await held;
      await services.remote.complete(machine.id, task.id, `Bearer ${machine.token}`, {
        taskId: task.id,
        exitCode: 0,
        stdout: '',
        stderr: '',
        files: answer(task.files),
      });
    }
  })();

  return {
    ops,
    tooLarge,
    /** Holds every answer until the returned function is called. */
    hold() {
      let release = () => {};
      held = new Promise((resolve) => {
        release = () => {
          held = undefined;
          resolve();
        };
      });
      return release;
    },
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

const workers: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

async function setup({ capabilities = 'files-v1', polling = true } = {}) {
  let now = Date.parse('2026-11-05T10:00:00Z');
  const clock = () => now;
  const services = await testServices(clock);
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const machine = await services.remote.create({ name: 'Studio' });
  await services.remote.poll(
    machine.id,
    `Bearer ${machine.token}`,
    'linux-x64',
    capabilities,
    'unlocked',
  );
  const projectId = randomUUID();
  await services.store.db.insert(projects).values({
    id: projectId,
    profileId: profile.id,
    name: 'example/harbor',
    repositoryUrl: 'https://example.test/harbor.git',
  });
  const worker = polling ? fakeWorker(services, machine, capabilities) : undefined;
  if (worker) workers.push(worker);
  return {
    services,
    profile,
    machine,
    projectId,
    worker,
    advance: (ms: number) => {
      now += ms;
    },
    /** A conversation on the machine whose repositories are cloned into `cloneInto`. */
    conversation: async (cloneInto?: string, profileId = profile.id, project = projectId) => {
      const session = await services.sessions.createGatewaySession(profileId, {
        projectId: project,
      });
      await services.sessions.setGatewayTarget(profileId, session.id, {
        projectId: project,
        remoteMachineId: machine.id,
        ...(cloneInto ? { cloneInto } : {}),
      });
      return session;
    },
  };
}

/** A clone of the project at `<into>/harbor`, as github_git would have made it. */
function cloneInto() {
  const into = mkdtempSync(join(root, 'into-'));
  const source = repository();
  git(into, 'clone', '-q', source, 'harbor');
  return { into, clone: join(into, 'harbor') };
}

describe('changes on a machine', () => {
  it("read a worktree of the conversation's machine against its merge base", async () => {
    const { services, profile, machine, worker, conversation } = await setup();
    const session = await conversation();
    const source = repository();
    const path = join(root, `worktree-${randomUUID().slice(0, 8)}`);
    git(source, 'worktree', 'add', '-q', '-b', 'jian/calm-otter', path);
    await services.store.db.insert(sessionWorktrees).values({
      id: randomUUID(),
      profileId: profile.id,
      sessionId: session.id,
      name: 'calm-otter',
      branch: 'jian/calm-otter',
      base: 'main',
      source,
      path,
      place: machine.id,
    });
    writeFileSync(join(path, 'committed.txt'), 'in a commit\n');
    git(path, 'add', '.');
    git(path, '-c', 'user.email=ana@example.test', '-c', 'user.name=Ana', 'commit', '-qm', 'Add');
    writeFileSync(join(path, 'modified.txt'), 'edited\n');
    unlinkSync(join(path, 'deleted.txt'));
    writeFileSync(join(path, 'loose.txt'), 'untracked\n');
    // The base moves on after the branch was made: its new file is not the worktree's work.
    writeFileSync(join(source, 'elsewhere.txt'), 'base work\n');
    git(source, 'add', '.');
    git(source, '-c', 'user.email=ana@example.test', '-c', 'user.name=Ana', 'commit', '-qm', 'B');

    const changes = await services.sessions.changes(profile.id, session.id);
    expect(sessionChangesSchema.safeParse(changes).success).toBe(true);
    expect(new Map(changes.files.map((file) => [file.path, file.status]))).toEqual(
      new Map([
        ['committed.txt', 'added'],
        ['modified.txt', 'modified'],
        ['deleted.txt', 'deleted'],
        ['loose.txt', 'untracked'],
      ]),
    );
    const base = git(path, 'merge-base', 'main', 'HEAD');
    expect(worker?.ops.slice(0, 2)).toEqual([
      { op: 'merge-base', root: path, base: 'main' },
      { op: 'git-status', root: path, against: base },
    ]);

    const named = await services.sessions.changes(profile.id, session.id, {
      worktree: 'calm-otter',
      path: 'modified.txt',
    });
    expect(named.files[0]?.diff?.hunks[0]?.lines).toEqual([
      { kind: 'del', old: 1, text: 'before' },
      { kind: 'add', new: 1, text: 'edited' },
    ]);
    expect(worker?.ops.at(-1)).toMatchObject({
      op: 'git-file',
      path: 'modified.txt',
      against: base,
    });
    const committed = await services.sessions.changes(profile.id, session.id, {
      path: 'committed.txt',
    });
    expect(committed.files[0]?.diff).toMatchObject({ created: true, additions: 1 });
  });

  it('read the project clone in the folder the conversation clones into', async () => {
    const { services, profile, worker, conversation } = await setup();
    const { into, clone } = cloneInto();
    const session = await conversation(into);
    writeFileSync(join(clone, 'modified.txt'), 'one\ntwo\n');
    unlinkSync(join(clone, 'deleted.txt'));

    const changes = await services.sessions.changes(profile.id, session.id);
    expect(new Map(changes.files.map((file) => [file.path, file.status]))).toEqual(
      new Map([
        ['modified.txt', 'modified'],
        ['deleted.txt', 'deleted'],
      ]),
    );
    expect(worker?.ops[0]).toEqual({ op: 'git-status', root: clone });
    // Git's NUL-separated output reached the gateway, and the task row keeps none of it.
    const [task] = await services.store.db.select().from(remoteTasks);
    expect(task?.result).toMatchObject({ files: { ok: true, op: 'git-status', top: clone } });
    expect(JSON.stringify(task?.result)).not.toContain('modified.txt');

    const whole = await services.sessions.changes(profile.id, session.id, {
      path: 'modified.txt',
      whole: 'true',
    });
    expect(sessionChangesSchema.safeParse(whole).success).toBe(true);
    expect(whole.files[0]?.diff).toMatchObject({ additions: 2, deletions: 1 });
    expect(whole.files[0]?.lines).toEqual(['one', 'two']);
    const deleted = await services.sessions.changes(profile.id, session.id, {
      path: 'deleted.txt',
    });
    expect(deleted.files[0]?.diff).toMatchObject({ deletions: 1, additions: 0 });
    // Only changed files are asked for: anything else is not a path the route reads.
    await expect(
      services.sessions.changes(profile.id, session.id, { path: '../outside.txt' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('read the clone github_git recorded on the machine when nothing says where to clone', async () => {
    const { services, profile, machine, conversation } = await setup();
    const { clone } = cloneInto();
    const session = await conversation();
    await services.workspaces.cloned(profile.id, session.id, machine.id, clone);
    writeFileSync(join(clone, 'fresh.txt'), 'fresh\n');

    const changes = await services.sessions.changes(profile.id, session.id);
    expect(changes.files).toEqual([{ path: 'fresh.txt', status: 'untracked' }]);
  });

  it('show a side over the machine limit as too large to display', async () => {
    const { services, profile, worker, conversation } = await setup();
    const { into, clone } = cloneInto();
    const session = await conversation(into);
    writeFileSync(join(clone, 'large.txt'), 'grown\n');
    worker?.tooLarge.add('large.txt');

    const large = await services.sessions.changes(profile.id, session.id, { path: 'large.txt' });
    expect(large.files[0]).toMatchObject({
      path: 'large.txt',
      unavailable: 'The file is too large to display.',
    });
  });

  it('ask the machine once per poll window, and again once a run of the conversation ends', async () => {
    const { services, profile, worker, conversation, advance } = await setup();
    const { into, clone } = cloneInto();
    const session = await conversation(into);
    writeFileSync(join(clone, 'modified.txt'), 'first\n');

    await services.sessions.changes(profile.id, session.id);
    advance(5_000);
    await services.sessions.changes(profile.id, session.id);
    expect(worker?.ops).toHaveLength(1);

    // A turn that ended may have edited the checkout: what was read before it is not shown.
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Work',
      requestKey: randomUUID(),
    });
    await services.store.db
      .update(runs)
      .set({ status: 'completed', updatedAt: new Date(Date.parse('2026-11-05T10:00:06Z')) })
      .where(eq(runs.id, run.id));
    writeFileSync(join(clone, 'added.txt'), 'new\n');
    const after = await services.sessions.changes(profile.id, session.id);
    expect(worker?.ops).toHaveLength(2);
    expect(after.files.map((file) => file.path)).toContain('added.txt');

    advance(11_000);
    await services.sessions.changes(profile.id, session.id);
    expect(worker?.ops).toHaveLength(3);
  });

  it("never answer one profile's conversation from another's read", async () => {
    const { services, profile, worker, conversation } = await setup();
    const other = await services.profiles.createProfile({ name: 'Rook', instructions: 'Help.' });
    const theirs = randomUUID();
    await services.store.db.insert(projects).values({
      id: theirs,
      profileId: other.id,
      name: 'example/harbor',
      repositoryUrl: 'https://example.test/harbor.git',
    });
    const { into } = cloneInto();
    const mine = await conversation(into);
    const second = await conversation(into, other.id, theirs);

    await services.sessions.changes(profile.id, mine.id);
    await services.sessions.changes(other.id, second.id);
    expect(worker?.ops).toHaveLength(2);
  });

  it('refuse a machine whose Jian Remote cannot read files', async () => {
    const { services, profile, conversation } = await setup({ capabilities: '' });
    const { into } = cloneInto();
    const session = await conversation(into);

    await expect(services.sessions.changes(profile.id, session.id)).rejects.toMatchObject({
      statusCode: 409,
      message: 'Studio runs a Jian Remote too old to show changes. Update Jian Remote there.',
    });
  });

  it('answer 503 while the machine is offline', async () => {
    const { services, profile, conversation, advance } = await setup({ polling: false });
    const { into } = cloneInto();
    const session = await conversation(into);
    advance(120_000);

    await expect(services.sessions.changes(profile.id, session.id)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('keep the refusal when no clone of the project is known on the machine', async () => {
    const { services, profile, worker, conversation } = await setup();
    const session = await conversation();

    await expect(services.sessions.changes(profile.id, session.id)).rejects.toMatchObject({
      statusCode: 409,
      message:
        "Jian does not know a checkout of this project on the conversation's machine yet: ask the agent to clone it there with github_git, or to work in a worktree.",
    });
    expect(worker?.ops).toEqual([]);
  });
  it('read the worktree where a retargeted conversation now works, and the other only when named', async () => {
    const { services, profile, machine, worker } = await setup();
    const session = await services.sessions.createGatewaySession(profile.id, {});
    const worktreeOf = async (name: string, place: string) => {
      const source = repository();
      // The gateway reads its own worktrees only under the folder the agents share.
      const base = place === 'gateway' ? (process.env.JIAN_WORKSPACES ?? root) : root;
      const path = join(base, `${name}-${randomUUID().slice(0, 8)}`);
      git(source, 'worktree', 'add', '-q', '-b', `jian/${name}`, path);
      await services.store.db.insert(sessionWorktrees).values({
        id: randomUUID(),
        profileId: profile.id,
        sessionId: session.id,
        name,
        branch: `jian/${name}`,
        base: 'main',
        source,
        path,
        place,
      });
      writeFileSync(join(path, `${name}.txt`), 'work\n');
      return path;
    };
    await worktreeOf('old-heron', 'gateway');
    const onMachine = await worktreeOf('calm-otter', machine.id);
    await services.sessions.setGatewayTarget(profile.id, session.id, {
      projectId: null,
      remoteMachineId: machine.id,
    });

    const changes = await services.sessions.changes(profile.id, session.id);
    expect(changes.files.map((file) => file.path)).toEqual(['calm-otter.txt']);
    expect(worker?.ops[0]).toEqual({ op: 'merge-base', root: onMachine, base: 'main' });
    const named = await services.sessions.changes(profile.id, session.id, {
      worktree: 'old-heron',
    });
    expect(named.files.map((file) => file.path)).toEqual(['old-heron.txt']);
  });

  it('show a file with a NUL anywhere as binary', async () => {
    const { services, profile, conversation } = await setup();
    const { into, clone } = cloneInto();
    const session = await conversation(into);
    writeFileSync(join(clone, 'modified.txt'), `${'text\n'.repeat(3000)}\0tail\n`);

    const file = await services.sessions.changes(profile.id, session.id, {
      path: 'modified.txt',
    });
    expect(file.files[0]?.unavailable).toBe('Binary files have no text diff.');
  });

  it('hand a busy machine the same read once, however long it takes', async () => {
    const { services, profile, worker, conversation, advance } = await setup();
    const { into } = cloneInto();
    const session = await conversation(into);
    const release = worker?.hold() ?? (() => {});

    const first = services.sessions.changes(profile.id, session.id);
    await expect.poll(() => worker?.ops.length).toBe(1);
    advance(11_000);
    const second = services.sessions.changes(profile.id, session.id);
    release();
    await Promise.all([first, second]);
    expect(worker?.ops).toHaveLength(1);
  });

  it('name both folders when the project was cloned twice on the machine', async () => {
    const { services, profile, machine, worker, conversation } = await setup();
    const session = await conversation();
    const one = cloneInto().clone;
    const two = cloneInto().clone;
    await services.workspaces.cloned(profile.id, session.id, machine.id, one);
    await services.workspaces.cloned(profile.id, session.id, machine.id, two);

    await expect(services.sessions.changes(profile.id, session.id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(
        new RegExp(`more than one clone.*${one}.*${two}|more than one clone.*${two}.*${one}`),
      ),
    });
    expect(worker?.ops).toEqual([]);
  });
});

describe('answers kept from machines', () => {
  it('keep a bounded number, letting go of the oldest first', async () => {
    const answers = new MachineAnswers(() => 0);
    const scope = { profileId: 'p', sessionId: 's', machineId: 'm', runs: '0|' };
    let asked = 0;
    const read = (index: number) =>
      answers.answer(scope, { op: 'git-status', root: `/work/${index}` }, async () => {
        asked += 1;
        return { ok: true, op: 'git-status', top: `/work/${index}`, filters: [], status: '' };
      });
    for (let index = 0; index < 70; index += 1) await read(index);
    expect(asked).toBe(70);

    await read(69);
    expect(asked).toBe(70);
    await read(0);
    expect(asked).toBe(71);
  });
});
