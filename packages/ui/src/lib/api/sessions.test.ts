import { afterEach, expect, it, vi } from 'vitest';
import { gatewayApi } from '.';

afterEach(() => vi.unstubAllGlobals());

it('asks for conflicts to be fixed with only what the route accepts, given a whole pull', async () => {
  const fetch = vi.fn(async () => Response.json({ id: 'run' }, { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  const pull = {
    owner: 'octo-example',
    repo: 'site',
    number: 7,
    url: 'https://github.com/octo-example/site/pull/7',
    title: 'Example',
  };
  await gatewayApi().fixGithubConflicts('profile', 'session', pull);
  const [request] = fetch.mock.calls[0] as unknown as [Request];
  expect(request.url).toBe(
    `${window.location.origin}/v1/profiles/profile/sessions/session/github/fix-conflicts`,
  );
  expect(await request.json()).toEqual({ owner: 'octo-example', repo: 'site', number: 7 });
});
