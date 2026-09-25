import { expect, it } from 'vitest';
import { REPOSITORY_URL, RepositoryStars } from '../src/releases/repository.js';

it('reads the stars once an hour, and keeps the last count when GitHub fails', async () => {
  let now = 0;
  let calls = 0;
  let answer: () => Response = () => Response.json({ stargazers_count: 42 });
  const stars = new RepositoryStars(
    (async () => {
      calls += 1;
      return answer();
    }) as typeof fetch,
    () => now,
  );

  expect(await stars.read()).toEqual({ url: REPOSITORY_URL, stars: 42 });
  await stars.read();
  expect(calls).toBe(1);

  now += 61 * 60_000;
  answer = () => new Response('rate limited', { status: 403 });

  expect(await stars.read()).toEqual({ url: REPOSITORY_URL, stars: 42 });
});

it('still gives the link when GitHub was never reached', async () => {
  const stars = new RepositoryStars((async () => {
    throw new Error('offline');
  }) as typeof fetch);

  expect(await stars.read()).toEqual({ url: REPOSITORY_URL });
});
