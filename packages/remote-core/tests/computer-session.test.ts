import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import type { RemoteTask } from '@jian/contracts';
import { type ComputerPlatform, ComputerSession } from '../src/computer/session.ts';
import { runComputerTask } from '../src/computer/task.ts';

/**
 * A stand-in for the native helpers, speaking their protocol: one JSON request per line in,
 * one reply per line out, in order. A click answers with where it landed, so a test can see
 * what the helper was asked; `type crash` exits mid-request; `key slow` answers late;
 * `key resize` halves the display; `key denied` fails as a missing permission; `key pointers`
 * answers with the pointers it was asked to draw.
 */
const FAKE_HELPER = `
const { createInterface } = require('node:readline');
const reply = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let width = 1000;
const pointers = [];
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.cmd === 'geometry') {
    reply({ ok: true, originX: 0, originY: 0, pointWidth: width, pointHeight: 500 });
  } else if (request.cmd === 'ensureSession') {
    pointers.push([request.session, request.label, request.color].join('/'));
    reply({ ok: true });
  } else if (request.cmd === 'key' && request.key === 'pointers') {
    reply({ ok: false, error: pointers.join(' ') + ' by ' + request.session });
  } else if (request.cmd === 'key' && request.key === 'resize') {
    width = 500;
    reply({ ok: true });
  } else if (request.cmd === 'key' && request.key === 'denied') {
    reply({
      ok: false,
      error: 'Accessibility is not granted.',
      code: 'perm_denied',
      delivery: 'not_delivered',
      permission: 'accessibility',
    });
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

  it('stops the helper of a task that outlives its time limit, and says it may have landed', async () => {
    const fake = fakePlatform();
    const session = new ComputerSession(fake.platform);
    try {
      const slow = { action: 'key', key: 'slow', protocol: 2 } as const;
      const result = await runComputerTask(session, task(slow, 100));
      assert.equal(result.timedOut, true);
      assert.equal(result.exitCode, null);
      assert.match(String(result.computer?.error), /timed out/);
      assert.equal(result.computer?.code, 'timeout');
      assert.equal(result.computer?.delivery, 'uncertain');

      // Nobody knows how far it got, so the screen has to be looked at before acting again.
      const blind = await session.runAction({ action: 'key', key: 'Return' });
      assert.equal(blind.computer?.code, 'screen_changed');
      // The helper that was still at it is gone, so its late key press cannot land under
      // whatever comes next: that runs on a new one.
      const next = await session.runAction({ action: 'screenshot' });
      assert.equal(next.computer?.ok, true);
      assert.equal(fake.launches(), 2);
    } finally {
      await session.end();
    }
  });

  it('keeps code and delivery from a gateway that did not ask for them', async () => {
    const session = new ComputerSession(fakePlatform().platform);
    try {
      const asked = await runComputerTask(
        session,
        task({ action: 'left_click', coordinate: [1, 1], protocol: 2 }),
      );
      assert.equal(asked.computer?.code, 'invalid_args');
      assert.equal(asked.computer?.delivery, 'not_delivered');

      const legacy = await runComputerTask(
        session,
        task({ action: 'left_click', coordinate: [1, 1] }),
      );
      // Its result schema is strict: one more key and it would refuse the whole result.
      assert.deepEqual(legacy.computer, {
        ok: false,
        error: 'Take a screenshot before using screen coordinates.',
      });
    } finally {
      await session.end();
    }
  });

  it('passes on what the helper said of a failure, and restarts one that lacked a permission', async () => {
    const fake = fakePlatform();
    const session = new ComputerSession(fake.platform);
    try {
      const denied = await session.runAction({ action: 'key', key: 'denied' });
      assert.equal(denied.computer?.code, 'perm_denied');
      assert.equal(denied.computer?.delivery, 'not_delivered');
      assert.equal(denied.computer?.permission, 'accessibility');

      const unnamed = await session.runAction({ action: 'screenshot' });
      const click = await session.runAction({ action: 'left_click', coordinate: [0, 0] });
      assert.equal(unnamed.computer?.ok, true);
      assert.equal(click.computer?.code, 'failed');
      assert.equal(click.computer?.delivery, 'uncertain');
      assert.equal(fake.launches(), 2);
    } finally {
      await session.end();
    }
  });

  it('reads the display again for every screenshot', async () => {
    const session = new ComputerSession(fakePlatform().platform);
    try {
      await session.runAction({ action: 'screenshot' });
      await session.runAction({ action: 'key', key: 'resize' });
      const shot = await session.runAction({ action: 'screenshot' });
      assert.deepEqual(shot.computer?.scale, { imageToPointX: 0.25, imageToPointY: 0.5 });
      const click = await session.runAction({ action: 'left_click', coordinate: [10, 10] });
      assert.equal(click.computer?.error, 'at 2.625,5.25 left');
    } finally {
      await session.end();
    }
  });

  it('gives each conversation its own pointer and its own last screenshot', async () => {
    const fake = fakePlatform();
    const session = new ComputerSession(fake.platform);
    const mia = { id: 'a', name: 'Mia', color: '#4299ff' };
    const rex = { id: 'b', name: 'Rex', color: '#ff6b5e' };
    try {
      await session.runAction({ action: 'screenshot', session: mia });
      const blind = await session.runAction({
        action: 'mouse_move',
        coordinate: [1, 1],
        session: rex,
      });
      assert.match(String(blind.computer?.error), /Take a screenshot/);

      const drawn = await session.runAction({ action: 'key', key: 'pointers', session: mia });
      assert.equal(drawn.computer?.error, 'a/Mia/#4299ff b/Rex/#ff6b5e by a');
      assert.equal(fake.launches(), 1);
    } finally {
      await session.end();
    }
  });

  it('refuses an action aimed at a screen another conversation changed since', async () => {
    const session = new ComputerSession(fakePlatform().platform);
    const mia = { id: 'a', name: 'Mia', color: '#4299ff' };
    const rex = { id: 'b', name: 'Rex', color: '#ff6b5e' };
    try {
      await session.runAction({ action: 'screenshot', session: mia });
      await session.runAction({ action: 'screenshot', session: rex });
      const typed = await session.runAction({ action: 'type', text: 'hello', session: mia });
      assert.equal(typed.computer?.ok, true);

      const stale = await session.runAction({ action: 'key', key: 'Return', session: rex });
      assert.equal(stale.computer?.code, 'screen_changed');
      assert.equal(stale.computer?.delivery, 'not_delivered');
      // Moving its own pointer changes nothing for anyone, so it needs no fresh look.
      const move = await session.runAction({
        action: 'mouse_move',
        coordinate: [1, 1],
        session: rex,
      });
      assert.equal(move.computer?.ok, true);

      await session.runAction({ action: 'screenshot', session: rex });
      const fresh = await session.runAction({ action: 'key', key: 'Return', session: rex });
      assert.equal(fresh.computer?.ok, true);
      // And the first one is now the one that has to look again.
      const back = await session.runAction({ action: 'key', key: 'Return', session: mia });
      assert.equal(back.computer?.code, 'screen_changed');
    } finally {
      await session.end();
    }
  });

  it('runs actions that arrive together one at a time, in order', async () => {
    const session = new ComputerSession(fakePlatform().platform);
    try {
      const order: string[] = [];
      const slow = session.runAction({ action: 'key', key: 'slow' }).then(() => order.push('slow'));
      const fast = session
        .runAction({ action: 'key', key: 'Return' })
        .then(() => order.push('fast'));
      await Promise.all([slow, fast]);
      assert.deepEqual(order, ['slow', 'fast']);
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
