import type { RunProgress } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
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
  it('coalesces a burst of tokens into one write', async () => {
    const { subject, written, advance } = reporter();

    for (const text of ['Bom ', 'Bom dia', 'Bom dia, tudo ', 'Bom dia, tudo certo']) {
      subject.draft(text);
      advance(50);
    }

    await subject.flush();

    // The first token goes out at once; the rest of the burst costs a single further write.
    expect(written).toHaveLength(2);
    expect(written[0]?.text).toBe('Bom ');
    expect(written.at(-1)?.text).toBe('Bom dia, tudo certo');
    expect(written.at(-1)?.phase).toBe('writing');
  });

  it('drops the text a tool interrupted, so the preview converges on the answer', async () => {
    const { subject, written, advance } = reporter();

    subject.draft('Deixa eu verificar uma coisa');
    advance(1000);
    subject.usingTool('read_memories');
    advance(1000);
    subject.draft('Está tudo certo.');
    await subject.flush();

    expect(written.some((snapshot) => snapshot.phase === 'tool')).toBe(true);
    // Commentary written before the tool is not the answer, so it does not stay on screen.
    expect(written.at(-1)?.text).toBe('Está tudo certo.');
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

    subject.draft(`${'x'.repeat(9000)}fim`);
    await subject.flush();

    expect(written.at(-1)?.text).toHaveLength(8000);
    expect(written.at(-1)?.text.endsWith('fim')).toBe(true);
  });
});
