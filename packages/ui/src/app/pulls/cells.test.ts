import { expect, it } from 'vitest';
import { checksPill, decisionPill, mergePill } from './cells';

it('names failing checks before running ones, and passed only when all passed', () => {
  expect(checksPill(undefined)).toBeUndefined();
  expect(checksPill({ passing: 3, failing: 1, pending: 1 })).toEqual({
    text: '1/5 failing',
    tone: 'bad',
  });
  expect(checksPill({ passing: 3, failing: 0, pending: 2 })).toEqual({
    text: '2/5 running',
    tone: 'warn',
  });
  expect(checksPill({ passing: 4, failing: 0, pending: 0 })).toEqual({
    text: '4/4 passed',
    tone: 'good',
  });
});

it('says a draft is a draft, whatever GitHub thinks of merging it', () => {
  expect(mergePill({ draft: true, mergeable: 'clean' }).text).toBe('Draft');
  expect(mergePill({ draft: false, mergeable: 'conflicts' })).toEqual({
    text: 'Conflicts',
    tone: 'bad',
  });
  expect(mergePill({ draft: false, mergeable: 'unknown' }).text).toBe('Checking');
});

it('shows a review decision only when the repository requires one', () => {
  expect(decisionPill(undefined)).toBeUndefined();
  expect(decisionPill('changes_requested')?.tone).toBe('bad');
});
