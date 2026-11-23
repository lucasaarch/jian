import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { RemoteTask } from '@jian/contracts';
import { executeShellTask } from '../src/shell.ts';

const shellTask = (command: string, timeoutMs: number): RemoteTask => ({
  id: '00000000-0000-4000-8000-000000000002',
  kind: 'shell',
  command,
  cwd: null,
  timeoutMs,
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number, withinMs: number) {
  const until = Date.now() + withinMs;
  while (alive(pid) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  return !alive(pid);
}

const pidIn = (stdout: string) => {
  const pid = Number(stdout.trim().split('\n').at(-1));
  assert.ok(Number.isInteger(pid) && pid > 1, `no pid in ${JSON.stringify(stdout)}`);
  return pid;
};

describe('a command and what it starts', { skip: process.platform === 'win32' }, () => {
  const left: number[] = [];
  after(() => {
    for (const pid of left) {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('a timed-out command takes its children with it and answers', async () => {
    const result = await executeShellTask(shellTask('sleep 30 & echo $!; wait', 300));
    const pid = pidIn(result.stdout);
    left.push(pid);
    assert.equal(result.timedOut, true);
    assert.equal(await gone(pid, 1000), true);
  });

  it('a child that ignores SIGTERM is killed all the same', async () => {
    const started = Date.now();
    const result = await executeShellTask(
      shellTask(`sh -c 'trap "" TERM; exec sleep 30' & echo $!; wait`, 300),
    );
    const pid = pidIn(result.stdout);
    left.push(pid);
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 4000);
    assert.equal(await gone(pid, 3500), true);
  });

  it('a job left running with its output in a file survives the command', async () => {
    const result = await executeShellTask(
      shellTask('nohup sleep 30 > /dev/null 2>&1 < /dev/null & echo $!', 5000),
    );
    const pid = pidIn(result.stdout);
    left.push(pid);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(alive(pid), true);
  });

  it('a job holding the pipes neither blocks the answer nor dies on its next write', async () => {
    const started = Date.now();
    const result = await executeShellTask(
      shellTask(`sh -c 'sleep 1.6; echo late; exec sleep 30' & echo $!`, 20_000),
    );
    const pid = pidIn(result.stdout);
    left.push(pid);
    assert.equal(result.timedOut, false);
    assert.ok(Date.now() - started < 1500);
    // Past its write: with the pipe closed it would have died of SIGPIPE here.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(alive(pid), true);
  });
});
