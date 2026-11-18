import { expect, it } from 'vitest';
import { frameRequest } from './frame-requests';

const from = (headers: Record<string, string>) => new Headers(headers);

it('signs the fetches the panel makes from its own origin', () => {
  const panel = from({ 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' });

  expect(frameRequest('/v1/profiles', panel)).toBe('sign');
});

it('refuses a frame sent to the gateway, whichever origin it navigates from', () => {
  expect(frameRequest('/v1/profiles', from({ 'sec-fetch-dest': 'iframe' }))).toBe('refuse');
  expect(frameRequest('/v1/profiles', from({ 'sec-fetch-dest': 'document' }))).toBe('refuse');
  expect(frameRequest('/v1/profiles', from({ 'sec-fetch-site': 'cross-site' }))).toBe('refuse');
});

it('lets the panel load the artifact frame, without a credential', () => {
  const loading = from({ 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' });

  expect(frameRequest('/v1/artifact-frames/html', loading)).toBe('unsigned');
});
