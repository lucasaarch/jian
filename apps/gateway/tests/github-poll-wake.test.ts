import { expect, it } from 'vitest';
import {
  canonicalizeObservation,
  detectPollWake,
  observationsEqual,
  observationToStore,
  stabilizeObservation,
} from '../src/subscriptions/github-poll.js';

const filter = {
  owner: 'lucasaarch',
  repo: 'jian',
  events: ['check_suite.completed', 'pull_request.closed'] as Array<
    'check_suite.completed' | 'pull_request.closed'
  >,
  pullNumber: 47,
  checkName: 'Check',
  pollIntervalSeconds: 20,
};

const openPending = {
  pullState: 'open' as const,
  merged: false,
  headSha: 'abc123def',
  checksCompleted: false,
};

const openGreen = {
  pullState: 'open' as const,
  merged: false,
  headSha: 'abc123def',
  checksCompleted: true,
  checkConclusion: 'success',
};

const openRed = {
  ...openGreen,
  checkConclusion: 'failure',
};

const merged = {
  pullState: 'closed' as const,
  merged: true,
  headSha: 'abc123def',
  checksCompleted: true,
  checkConclusion: 'success',
};

it('treats equivalent pending snapshots as equal', () => {
  expect(observationsEqual(openPending, { ...openPending })).toBe(true);
  expect(observationsEqual(openPending, openGreen)).toBe(false);
});

it('latches a completed check snapshot when GitHub briefly returns incomplete runs', () => {
  const flickered = stabilizeObservation(openGreen, {
    pullState: 'open',
    merged: false,
    headSha: 'abc123def',
    checksCompleted: false,
  });
  expect(flickered.checksCompleted).toBe(true);
  expect(flickered.checkConclusion).toBe('success');
  expect(observationsEqual(openGreen, flickered)).toBe(true);
});

it('keeps the prior snapshot when a poll returns empty (fetch error)', () => {
  const kept = stabilizeObservation(openGreen, {});
  expect(kept).toEqual(canonicalizeObservation(openGreen));
  expect(detectPollWake({ filter: { ...filter }, lastObservation: openGreen }, {})).toBeUndefined();
});

it('does not wake when the snapshot is unchanged', () => {
  expect(
    detectPollWake({ filter: { ...filter }, lastObservation: openPending }, openPending),
  ).toBeUndefined();
  expect(
    detectPollWake({ filter: { ...filter }, lastObservation: openGreen }, openGreen),
  ).toBeUndefined();
});

it('wakes once when checks go pending → success and includes a delta', () => {
  const wake = detectPollWake({ filter: { ...filter }, lastObservation: openPending }, openGreen);
  expect(wake?.event).toBe('check_suite.completed');
  expect(wake?.summary.some((line) => line.includes('Changed: checks pending → success'))).toBe(
    true,
  );
});

it('does not re-wake on steady open + green (waiting for merge)', () => {
  expect(
    detectPollWake({ filter: { ...filter }, lastObservation: openGreen }, openGreen),
  ).toBeUndefined();
  // Incomplete flicker must not unlock another wake for the same head + conclusion.
  expect(
    detectPollWake(
      { filter: { ...filter }, lastObservation: openGreen },
      { ...openPending, checksCompleted: false },
    ),
  ).toBeUndefined();
  const stored = observationToStore(openGreen, { ...openPending, checksCompleted: false });
  expect(
    detectPollWake({ filter: { ...filter }, lastObservation: stored }, openGreen),
  ).toBeUndefined();
});

it('wakes when the check conclusion changes success → failure', () => {
  const wake = detectPollWake({ filter: { ...filter }, lastObservation: openGreen }, openRed);
  expect(wake?.event).toBe('check_suite.completed');
  expect(wake?.summary.some((line) => line.includes('Changed: checks success → failure'))).toBe(
    true,
  );
});

it('wakes when the pull request merges', () => {
  const wake = detectPollWake({ filter: { ...filter }, lastObservation: openGreen }, merged);
  expect(wake?.event).toBe('pull_request.closed');
  expect(wake?.summary.some((line) => line.includes('Changed: pull open → merged'))).toBe(true);
});
