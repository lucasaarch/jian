import type { RunProgress } from '@jian/contracts';
import { describe, expect, it, vi } from 'vitest';
import { Narrator } from '../src/agent/narrator.js';
import { ProgressReporter } from '../src/agent/progress.js';

function reporter(every = 1000) {
  const written: RunProgress[] = [];
  let now = 0;

  return {
    written,
    advance: (ms: number) => {
      now += ms;
    },
    subject: new ProgressReporter(
      async (snapshot) => {
        written.push(snapshot);
      },
      every,
      () => now,
    ),
  };
}

describe('what a run reports while it runs', () => {
  it('writes tokens at most every 250 ms by default', async () => {
    const written: RunProgress[] = [];
    let now = 0;
    const subject = new ProgressReporter(
      async (snapshot) => {
        written.push(snapshot);
      },
      undefined,
      () => now,
    );

    // A flush would write whatever waits, so let the writer settle on its own instead.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    subject.draft('a');
    await settle();
    now = 200;
    subject.draft('ab');
    await settle();
    expect(written).toHaveLength(1);

    now = 260;
    subject.draft('abc');
    await settle();
    expect(written).toHaveLength(2);
    expect(written[1]?.text).toBe('abc');
  });

  it('writes an emptied draft at once after a released paragraph', async () => {
    const { subject, written, advance } = reporter(250);
    // A flush would write whatever waits, so let the writer settle on its own instead.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    subject.draft('Found the PR.');
    await settle();
    advance(100);
    // The paragraph went out as a message; what follows is a tool's input, which marks nothing.
    subject.draft('');
    await settle();

    expect(written).toHaveLength(2);
    expect(written.at(-1)).toMatchObject({ phase: 'writing', text: '' });
  });

  it('writes a held token snapshot once the interval passes without another change', async () => {
    vi.useFakeTimers();
    try {
      const written: RunProgress[] = [];
      let now = 0;
      const subject = new ProgressReporter(
        async (snapshot) => {
          written.push(snapshot);
        },
        250,
        () => now,
      );
      const pass = async (ms: number) => {
        now += ms;
        await vi.advanceTimersByTimeAsync(ms);
      };

      subject.draft('Checking');
      await pass(100);
      subject.draft('Checking the');
      await pass(100);
      expect(written.map((snapshot) => snapshot.text)).toEqual(['Checking']);

      // Nothing else changes, yet the held snapshot goes out as the interval ends.
      await pass(50);
      expect(written.map((snapshot) => snapshot.text)).toEqual(['Checking', 'Checking the']);
      await pass(1_000);
      expect(written).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never writes a held token snapshot over a newer change of activity', async () => {
    // The fake clock moves with the fake timers, so the held write fires when it would for real.
    vi.useFakeTimers({ now: 0 });
    try {
      const written: RunProgress[] = [];
      const subject = new ProgressReporter(
        async (snapshot) => {
          written.push(snapshot);
        },
        250,
        () => Date.now(),
      );

      subject.draft('Para one.');
      subject.draft('Para one. Still');
      subject.draft('');
      subject.usingTool('shell');
      await vi.advanceTimersByTimeAsync(1_000);

      expect(written.map(({ phase, text }) => `${phase} "${text}"`)).toEqual([
        'writing "Para one."',
        'writing ""',
        'tool ""',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes a change of activity at once, even while a token snapshot waits', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const written: RunProgress[] = [];
      const subject = new ProgressReporter(
        async (snapshot) => {
          written.push(snapshot);
        },
        250,
        () => Date.now(),
      );

      subject.draft('Para one.');
      await vi.advanceTimersByTimeAsync(10);
      // Held: the interval has not passed. The emptied draft right after must not wait for it.
      subject.draft('Para one. Still');
      subject.draft('');
      await vi.advanceTimersByTimeAsync(0);

      expect(written.map((snapshot) => snapshot.text)).toEqual(['Para one.', '']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stamps marks in the same millisecond strictly later, so each is told', async () => {
    const { subject, written } = reporter(0);

    subject.draft('Para one.');
    subject.draft('');
    subject.usingTool('shell');
    await subject.flush();

    const stamps = written.map((snapshot) => Date.parse(snapshot.updatedAt));
    expect(written.map((snapshot) => snapshot.phase)).toEqual(['writing', 'writing', 'tool']);
    for (let at = 1; at < stamps.length; at += 1) {
      expect(stamps[at]).toBeGreaterThan(stamps[at - 1] as number);
    }
  });

  it('coalesces a burst of tokens into one write', async () => {
    const { subject, written, advance } = reporter();

    for (const text of ['Good ', 'Good morning', 'Good morning, all ', 'Good morning, all good']) {
      subject.draft(text);
      advance(50);
    }

    await subject.flush();

    // The first token goes out at once; the rest of the burst costs a single further write.
    expect(written).toHaveLength(2);
    expect(written[0]?.text).toBe('Good ');
    expect(written.at(-1)?.text).toBe('Good morning, all good');
    expect(written.at(-1)?.phase).toBe('writing');
  });

  it('drops the text a tool interrupted, so the preview converges on the answer', async () => {
    const { subject, written, advance } = reporter();

    subject.draft('Let me check one thing');
    advance(1000);
    subject.usingTool('read_memories');
    advance(1000);
    subject.draft('All good.');
    await subject.flush();

    expect(written.some((snapshot) => snapshot.phase === 'tool')).toBe(true);
    // Commentary written before the tool is not the answer, so it does not stay on screen.
    expect(written.at(-1)?.text).toBe('All good.');
  });

  it('leaves out of the draft a paragraph already sent as a message', async () => {
    const { subject, written } = reporter(0);
    const narrator = new Narrator(async () => {});

    for (const part of ['Found the PR.', '\n\nThe new ', 'commit is green.']) {
      await narrator.delta(part);
      subject.draft(narrator.draft);
    }

    await subject.flush();

    expect(written.at(-1)).toMatchObject({ phase: 'writing', text: 'The new commit is green.' });
  });

  it('remembers that a trailing blank line already released the answer', async () => {
    const released: string[] = [];
    const narrator = new Narrator(async (text) => {
      released.push(text);
    });

    await narrator.delta('Done on the remote.\n\n');

    expect(released).toEqual(['Done on the remote.']);
    expect(narrator.released).toBe(true);
    expect(narrator.finishedAsCommentary).toBe(true);
    expect(narrator.rest).toBe('');
    expect(narrator.lastSaid).toBe('Done on the remote.');
  });

  it('does not treat pre-tool commentary as a finished answer', async () => {
    const narrator = new Narrator(async () => {});

    await narrator.delta('Found it.');
    await narrator.endStep(true);

    expect(narrator.released).toBe(true);
    expect(narrator.finishedAsCommentary).toBe(false);
    expect(narrator.rest).toBe('');
    expect(narrator.lastSaid).toBe('Found it.');
  });

  it('never ends a run because a report failed', async () => {
    const failing = new ProgressReporter(async () => {
      throw new Error('database is gone');
    }, 0);

    failing.thinking();
    failing.draft('anything');

    await expect(failing.flush()).resolves.toBeUndefined();
  });

  it('keeps the tail when the answer outgrows what a snapshot holds', async () => {
    const { subject, written } = reporter(0);

    subject.draft(`${'x'.repeat(9000)}end`);
    await subject.flush();

    expect(written.at(-1)?.text).toHaveLength(8000);
    expect(written.at(-1)?.text.endsWith('end')).toBe(true);
  });
});
