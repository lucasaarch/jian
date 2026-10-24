import { afterEach, expect, it, vi } from 'vitest';
import { gatewayApi } from '.';

afterEach(() => vi.unstubAllGlobals());

it('uses authenticated panel requests for team CRUD and preserves multi-agent ids', async () => {
  const response = {
    id: 'team-1',
    name: 'Platform',
    description: 'Core team',
    profileIds: ['agent-a', 'agent-b'],
    createdAt: '',
    updatedAt: '',
  };
  const fetch = vi.fn(async (request: Request) => {
    if (request.method === 'GET') return Response.json([response]);
    return Response.json(response);
  });
  vi.stubGlobal('fetch', fetch);
  const api = gatewayApi();

  expect(await api.teams()).toEqual([response]);
  await api.createTeam({
    name: response.name,
    description: response.description,
    profileIds: response.profileIds,
  });
  await api.updateTeam(response.id, {
    name: response.name,
    description: response.description,
    profileIds: response.profileIds,
  });
  await api.deleteTeam(response.id);

  const requests = fetch.mock.calls.map(([request]) => request as unknown as Request);
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ['GET', '/v1/teams'],
    ['POST', '/v1/teams'],
    ['PATCH', '/v1/teams/team-1'],
    ['DELETE', '/v1/teams/team-1'],
  ]);
  expect(requests.every((request) => request.headers.get('x-jian-panel') === '1')).toBe(true);
  expect(await requests[1].json()).toEqual({
    name: 'Platform',
    description: 'Core team',
    profileIds: ['agent-a', 'agent-b'],
  });
  expect(await requests[2].json()).toEqual({
    name: 'Platform',
    description: 'Core team',
    profileIds: ['agent-a', 'agent-b'],
  });
});

it('surfaces gateway authorization errors for team management', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'Forbidden' }, { status: 403 })),
  );
  await expect(gatewayApi().teams()).rejects.toThrow('This action needs the host token.');
});
