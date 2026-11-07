import { afterEach, expect, it, vi } from 'vitest';
import { connectGateway, gatewayConnection } from '../../platform/gateway';
import { gatewayApi } from '.';

const panel = gatewayConnection();
afterEach(() => {
  vi.unstubAllGlobals();
  connectGateway(panel);
});

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

it('reads messages from a gateway that predates a page limit, and stops asking it for one', async () => {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      asked.push(new URL(request.url).search);
      return new URL(request.url).searchParams.has('limit')
        ? Response.json({ error: 'Invalid request' }, { status: 400 })
        : Response.json([]);
    }),
  );
  const api = gatewayApi();

  await expect(api.messages('profile', 'session', { limit: 40 })).resolves.toEqual([]);
  await expect(api.messages('profile', 'session', { before: 'm1', limit: 40 })).resolves.toEqual(
    [],
  );

  expect(asked).toEqual(['?limit=40', '', '?before=m1']);
});

it('asks for brief tools, and asks a gateway that predates them again without, once', async () => {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      asked.push(`${url.host}${url.search}`);
      return url.host === 'older.example' && url.searchParams.has('brief')
        ? Response.json({ error: 'Invalid request' }, { status: 400 })
        : Response.json([]);
    }),
  );
  const on = (origin: string) => {
    connectGateway({ origin, headers: {}, credentials: 'same-origin' });
    return gatewayApi();
  };
  const older = on('https://older.example');
  const newer = on('https://newer.example');

  await expect(older.timeline('profile', 'session', ['r1'], { brief: true })).resolves.toEqual([]);
  await expect(older.timeline('profile', 'session', ['r2'], { brief: true })).resolves.toEqual([]);
  await expect(newer.timeline('profile', 'session', ['r3'], { brief: true })).resolves.toEqual([]);
  await expect(newer.timeline('profile', 'session', ['r4'])).resolves.toEqual([]);

  expect(asked).toEqual([
    'older.example?runs=r1&brief=1',
    'older.example?runs=r1',
    'older.example?runs=r2',
    'newer.example?runs=r3&brief=1',
    'newer.example?runs=r4',
  ]);
});

it('reads one tool step of a conversation in full', async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      toolCallId: 'call_1/a',
      toolName: 'read_file',
      status: 'done',
      startedAt: '2026-11-07T10:00:00.000Z',
    }),
  );
  vi.stubGlobal('fetch', fetch);

  await expect(gatewayApi().toolStep('profile', 'session', 'call_1/a')).resolves.toMatchObject({
    toolName: 'read_file',
  });
  const [request] = fetch.mock.calls[0] as unknown as [Request];
  expect(new URL(request.url).pathname).toBe(
    '/v1/profiles/profile/sessions/session/steps/call_1%2Fa',
  );
});
