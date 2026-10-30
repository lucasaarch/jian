import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import type { RemoteTask } from '@jian/contracts';
import { type ComputerPlatform, ComputerSession } from '../src/computer/session.ts';
import { runComputerTask } from '../src/computer/task.ts';

/**
 * A stand-in for the native helpers, speaking their protocol: one JSON request per line in,
 * one reply per line out, in order. A click answers with where it landed, so a test can see
 * what the helper was asked; `type crash` exits mid-request; `key slow` answers late.
 */
const FAKE_HELPER = `
const { createInterface } = require('node:readline');
const reply = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.cmd === 'geometry') {
    reply({ ok: true, originX: 0, originY: 0, pointWidth: 1000, pointHeight: 500 });
  } else if (request.cmd === 'clickAt') {
    reply({ ok: false, error: 'at ' + request.pointX + ',' + request.pointY + ' ' + request.button });
  } else if (request.cmd === 'type' && request.text === 'crash') {
    process.exit(1);
  } else if (request.cmd === 'key' && request.key === 'slow') {
    setTimeout(() => reply({ ok: true }), 300);
  } else {
    reply({ ok: true });
  }
});
`;

function fakePlatform(command = process.execPath) {
  let launches = 0;
  const platform: ComputerPlatform = {
    async launch() {
      launches += 1;
      return spawn(command, ['-e', FAKE_HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
    },
    capture: () => ({ base64: 'AAAA', widthPx: 2000, heightPx: 1000 }),
  };
  return { platform, launches: () => launches };
}

const task = (computer: RemoteTask['computer'], timeoutMs = 5_000): RemoteTask => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'computer',
  command: null,
  cwd: null,
  timeoutMs,
  computer,
});

describe('computer session', () => {
  it('clicks where the last screenshot pixel is on the display', async () => {
    const session = new ComputerSession(fakePlatform().platform);
    try {
      const before = await session.runAction({ action: 'left_click', coordinate: [10, 10] });
      assert.equal(before.computer?.ok, false);
      assert.match(String(before.computer?.error), /Take a screenshot/);

      const shot = await session.runAction({ action: 'screenshot' });
      assert.equal(shot.stdout, 'AAAA');
      assert.deepEqual(shot.computer?.scale, { imageToPointX: 0.5, imageToPointY: 0.5 });

      const click = await session.runAction({ action: 'right_click', coordinate: [10, 10] });
      assert.equal(click.computer?.error, 'at 5.25,5.25 right');

      const outside = await session.runAction({ action: 'mouse_move', coordinate: [2000, 0] });
      assert.match(String(outside.computer?.error), /outside the last screenshot/);
    } finally {
      await session.end();
    }
  });

  it('reports a helper that dies mid-request, and starts a new one for the next action', async () => {
    const fake = fakePlatform();
    const session = new ComputerSession(fake.platform);
    try {
      const crashed = await session.runAction({ action: 'type', text: 'crash' });
      assert.equal(crashed.exitCode, 1);
      assert.equal(crashed.computer?.error, 'Computer-use helper exited unexpectedly.');

      const next = await session.runAction({ action: 'key', key: 'Return' });
      assert.equal(next.computer?.ok, true);
      assert.equal(fake.launches(), 2);
    } finally {
      await session.end();
    }
  });

  it('turns a helper that cannot start into a failed result, not a crash', async () => {
    const session = new ComputerSession(fakePlatform('/nonexistent/jian-helper').platform);
    const outcome = await session.runAction({ action: 'screenshot' });
    assert.equal(outcome.computer?.ok, false);
    assert.match(String(outcome.computer?.error), /ENOENT|not running/);
    await session.end();
  });

  it('answers a task that outlives its time limit as timed out', async () => {
    const session = new ComputerSession(fakePlatform().platform);
    try {
      const result = await runComputerTask(session, task({ action: 'key', key: 'slow' }, 100));
      assert.equal(result.timedOut, true);
      assert.equal(result.exitCode, null);
      assert.equal(result.computer?.error, 'Computer action timed out');
    } finally {
      await session.end();
    }
  });

  it('answers a task without an action as failed', async () => {
    const session = new ComputerSession(fakePlatform().platform);
    const result = await runComputerTask(session, task(undefined));
    assert.equal(result.computer?.ok, false);
    assert.equal(result.stderr, 'Computer task missing action.');
  });
});
