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

it('says a request to an organization was sent, as news and not a failure', () => {
  expect(outcome('github=requested')).toEqual({
    text: 'Your request to install Jian’s GitHub App was sent to the organization’s owners. Once one approves it, the account connects here by itself.',
    failed: false,
  });
  expect(outcome('github=requested&reason=manual')).toEqual({
    text: 'Your request to install Jian’s GitHub App was sent to the organization’s owners. Once one approves it, connect it here with Connect an approved installation.',
    failed: false,
  });
});

it('says when the signed-in account reaches no installation yet', () => {
  expect(outcome('github=failed&reason=none')).toEqual({
    text: 'No installation of Jian’s GitHub App is reachable with that GitHub account yet. If an owner still has to approve it, wait for the approval.',
    failed: true,
  });
});

it('reports success and stays quiet when GitHub left nothing', () => {
  expect(outcome('github=connected')).toEqual({ text: 'GitHub account connected.', failed: false });
  expect(outcome('tab=mcps')).toBeUndefined();
});
