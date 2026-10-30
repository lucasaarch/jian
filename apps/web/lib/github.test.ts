import { expect, it } from 'vitest';
import { githubOutcome } from './github';

const outcome = (query: string) => githubOutcome(new URLSearchParams(query));

it('says why a connection failed when the gateway names it', () => {
  expect(outcome('github=failed&reason=not-owner')).toEqual({
    text: 'The GitHub account you signed in with cannot manage that installation.',
    failed: true,
  });
});

it('still reports a failure whose reason it does not know', () => {
  expect(outcome('github=failed&reason=something-new')?.failed).toBe(true);
  expect(outcome('github=failed')?.failed).toBe(true);
});

it('reports success and stays quiet when GitHub left nothing', () => {
  expect(outcome('github=connected')).toEqual({ text: 'GitHub account connected.', failed: false });
  expect(outcome('tab=mcps')).toBeUndefined();
});
