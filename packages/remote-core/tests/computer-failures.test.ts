import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { HelperChannel } from '../src/computer/helper-channel.ts';
import { type ComputerPlatform, ComputerSession } from '../src/computer/session.ts';

/** Answers every request; `key slow` late, so an action can be in flight. */
const HELPER = `
const { createInterface } = require('node:readline');
const reply = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.cmd === 'geometry') {
    reply({ ok: true, originX: 0, originY: 0, pointWidth: 1000, pointHeight: 500 });
  } else if (request.cmd === 'key' && request.key === 'slow') {
    setTimeout(() => reply({ ok: true }), 250);
  } else {
    reply({ ok: true });
  }
});
`;

function helperPlatform() {
  const events = { launches: 0, released: 0 };
  const platform: ComputerPlatform = {
    async launch() {
      events.launches += 1;
      return spawn(process.execPath, ['-e', HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
    },
    capture: () => ({ base64: 'AAAA', widthPx: 1000, heightPx: 500 }),
    release: () => {
      events.released += 1;
    },
  };
  return { platform, events };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a helper that fails', { skip: process.platform === 'win32' }, () => {
  it('a broken pipe fails the request and leaves the worker running', async () => {
    const child = spawn('/bin/sh', ['-c', 'exec 0<&-; sleep 5'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let closed = 0;
    const channel = new HelperChannel(child, () => {
      closed += 1;
    });
    await assert.rejects(channel.request({ cmd: 'type', text: 'x'.repeat(4 * 1024 * 1024) }));
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(closed, 1);
    assert.equal(channel.alive, false);
  });
});

describe('an idle seat', () => {
  it('ends with its helper, and has to look again when it comes back', async () => {
    const { platform, events } = helperPlatform();
    const session = new ComputerSession(platform, { seatIdleMs: 60 });
    const seat = { id: 'seat', name: 'Mia', color: '#4299ff' };
    try {
      assert.equal((await session.runAction({ action: 'screenshot', session: seat })).exitCode, 0);
      await pause(250);
      assert.equal(events.released, 1);

      const back = await session.runAction({ action: 'key', key: 'Return', session: seat });
      assert.equal(back.computer?.code, 'screen_changed');
      assert.equal(back.computer?.delivery, 'not_delivered');
    } finally {
      await session.end();
    }
  });

  it('is never ended while an action is running', async () => {
    const { platform, events } = helperPlatform();
    const session = new ComputerSession(platform, { seatIdleMs: 40 });
    const seat = { id: 'seat', name: 'Mia', color: '#4299ff' };
    try {
      await session.runAction({ action: 'screenshot', session: seat });
      // Each runs past the idle time; the seat is still there for the one after it.
      for (let step = 0; step < 3; step += 1) {
        const slow = await session.runAction({ action: 'key', key: 'slow', session: seat });
        assert.equal(slow.computer?.ok, true);
      }
      assert.equal(events.released, 0);
      assert.equal(events.launches, 1);
    } finally {
      await session.end();
    }
  });
});
