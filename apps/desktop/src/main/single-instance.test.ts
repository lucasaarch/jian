import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { lockHolder, whenHolderLeft } from './single-instance';

const folders: string[] = [];
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), 'jian-lock-'));
  folders.push(made);
  return made;
};

afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

it('reads who holds the lock from the link Chromium leaves in the app’s folder', () => {
  const free = folder();
  const held = folder();
  symlinkSync('harbor.local-4242', join(held, 'SingletonLock'));

  expect(lockHolder(free)).toBeUndefined();
  expect(lockHolder(held)).toBe(4242);
});

it('waits until the holder is gone, however long it takes to stop', () => {
  let leaves = 3;
  const naps: number[] = [];

  const left = whenHolderLeft({
    holder: () => 4242,
    alive: () => leaves-- > 0,
    nap: (ms) => naps.push(ms),
  });

  expect(left).toBe(true);
  expect(naps).toEqual([250, 250, 250]);
});

it('does not wait for a holder that crashed and left its link behind', () => {
  const naps: number[] = [];

  expect(
    whenHolderLeft({ holder: () => 4242, alive: () => false, nap: (ms) => naps.push(ms) }),
  ).toBe(true);
  expect(naps).toEqual([]);
});

it('gives up on a holder that stays: a second launch, and not a restart', () => {
  let slept = 0;

  const left = whenHolderLeft({
    holder: () => 4242,
    alive: () => true,
    nap: (ms) => {
      slept += ms;
    },
  });

  expect(left).toBe(false);
  expect(slept).toBe(15_000);
});
