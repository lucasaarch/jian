import { delay, HttpResponse, http } from 'msw';
import * as data from './fixtures';

/**
 * The gateway, answered from the fixtures. A page story renders the real layout, which loads
 * everything over HTTP, so the whole API it touches is here — reads return the installation,
 * writes succeed and change nothing.
 */
const ok = <T>(value: T) => HttpResponse.json(value as never);
const byProfile = <T extends { profileId: string }>(items: T[], profileId: string) =>
  items.filter((item) => item.profileId === profileId);

export const handlers = [
  http.get('*/v1/profiles', () => ok(data.profiles)),
  http.get('*/v1/profiles/:profileId', ({ params }) =>
    ok(data.profiles.find((profile) => profile.id === params.profileId) ?? data.profiles[0]),
  ),
  http.patch('*/v1/profiles/:profileId', async ({ params, request }) => {
    const current = data.profiles.find((profile) => profile.id === params.profileId);

    const patch = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    return ok({ ...current, ...patch });
  }),
  http.delete('*/v1/profiles/:profileId', ({ params }) => ok({ id: params.profileId })),
  http.post('*/v1/profiles', async ({ request }) => {
    const input = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    return ok({ ...data.profiles[2], ...input });
  }),

  http.get('*/v1/profiles/:profileId/sessions', ({ params }) =>
    ok(byProfile(data.sessions, String(params.profileId))),
  ),
  http.get('*/v1/profiles/:profileId/sessions/:sessionId/messages', ({ params }) =>
    ok(data.messages.filter((message) => message.sessionId === params.sessionId)),
  ),
  http.get('*/v1/profiles/:profileId/activities', ({ params }) =>
    ok(byProfile(data.runs, String(params.profileId))),
  ),
  http.get('*/v1/profiles/:profileId/runs/:runId', ({ params }) =>
    ok(data.runs.find((run) => run.id === params.runId) ?? data.runs[0]),
  ),
  http.get('*/v1/profiles/:profileId/activity', () => ok(data.activityCalendar)),
  // The live feed: held open and silent, the way a quiet gateway keeps it.
  http.get('*/v1/profiles/:profileId/events/stream', () => {
    const stream = new ReadableStream({ start() {} });

    return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
  }),

  http.get('*/v1/profiles/:profileId/channels', ({ params }) =>
    ok(byProfile(data.channels, String(params.profileId))),
  ),
  http.post('*/v1/profiles/:profileId/channels', ({ params }) =>
    ok({
      ...data.channels[0],
      profileId: params.profileId,
      webhookToken: 'synthetic-webhook-token',
    }),
  ),
  http.get('*/v1/profiles/:profileId/channels/:channelId/connection', () => ok(data.connection)),
  http.get('*/v1/profiles/:profileId/channels/:channelId/qr', () =>
    ok({
      qr: 'synthetic-qr-payload-for-storybook',
      expiresAt: new Date(Date.now() + 45_000).toISOString(),
    }),
  ),
  http.post('*/v1/profiles/:profileId/channels/:channelId/:action', () => ok(data.connection)),
  http.delete('*/v1/profiles/:profileId/channels/:channelId', () => ok(data.channels[0])),
  http.get('*/v1/profiles/:profileId/contacts', ({ params }) =>
    ok(byProfile(data.contacts, String(params.profileId))),
  ),
  http.post('*/v1/profiles/:profileId/contacts/:contactId/:decision', ({ params }) =>
    ok(data.contacts.find((contact) => contact.id === params.contactId)),
  ),
  http.get('*/v1/groups', () => ok(data.groups)),
  http.get('*/v1/profiles/:profileId/deliveries', ({ params }) =>
    ok(byProfile(data.deliveries, String(params.profileId))),
  ),

  http.get('*/v1/profiles/:profileId/memories', ({ params }) =>
    ok(byProfile(data.memories, String(params.profileId))),
  ),
  http.delete('*/v1/profiles/:profileId/memories/:key', () => ok(data.memories[0])),

  http.get('*/v1/providers', () => ok(data.providers)),
  http.post('*/v1/providers', () => ok(data.providers[0])),
  http.delete('*/v1/providers/:providerId', () => ok(data.providers[0])),
  http.get('*/v1/providers/openai/oauth', () => ok({ status: 'connected' })),
  http.post('*/v1/providers/openai/oauth', () =>
    ok({
      status: 'pending',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    }),
  ),
  http.get('*/v1/providers/:providerId/models', ({ params }) =>
    ok(data.providerModels[String(params.providerId)]),
  ),
  http.get('*/v1/profiles/:profileId/model-defaults', () => ok(data.modelDefaults)),
  http.put('*/v1/profiles/:profileId/model-defaults', () => ok(data.modelDefaults)),

  http.get('*/v1/profiles/:profileId/built-in-skills', () => ok(data.builtinSkills)),
  http.get('*/v1/profiles/:profileId/skill-catalog', () =>
    ok({
      marketplace: 'example-skills',
      entries: [
        {
          name: 'concise',
          description: 'Answer in the first sentence.',
          url: 'https://github.com/example/skills/tree/main/concise',
        },
        {
          name: 'code-review',
          description: 'Review a diff for correctness.',
          url: 'https://github.com/example/skills/tree/main/code-review',
        },
      ],
    }),
  ),
  http.post('*/v1/profiles/:profileId/skills/import', ({ params }) =>
    ok(data.profiles.find((profile) => profile.id === params.profileId)),
  ),
  http.post('*/v1/profiles/:profileId/mcp-servers/:name/check', async ({ params }) => {
    await delay(400);

    return ok({
      name: params.name,
      reachable: true,
      tools: [
        { name: 'search_code', description: 'Search code across repositories.' },
        { name: 'create_issue', description: 'Open an issue.' },
        { name: 'list_pull_requests' },
      ],
      checkedAt: new Date().toISOString(),
    });
  }),

  http.get('*/v1/web-search', () =>
    ok({ provider: 'tavily', configured: true, updatedAt: '2026-09-20T12:00:00.000Z' }),
  ),
  http.put('*/v1/web-search', () =>
    ok({ provider: 'tavily', configured: true, updatedAt: new Date().toISOString() }),
  ),
  http.delete('*/v1/web-search', () => ok({ provider: 'tavily', configured: false })),
  http.get('*/v1/decisions', () => ok({ provider: 'jev', configured: false })),
  http.put('*/v1/decisions', () =>
    ok({ provider: 'jev', configured: true, updatedAt: new Date().toISOString() }),
  ),
  http.delete('*/v1/decisions', () => ok({ provider: 'jev', configured: false })),

  // Most stories are about a screen, not about the update dialog opening over it.
  http.get('*/v1/releases', () => ok({ ...data.releases, unseen: [] })),
  http.post('*/v1/releases/seen', () => ok({ ...data.releases, unseen: [] })),

  http.post('*/v1/panel/session', () => new HttpResponse(null, { status: 204 })),
  http.delete('*/v1/panel/session', () => new HttpResponse(null, { status: 204 })),
];

/** The same gateway with nothing in it yet: a first run. */
export const emptyHandlers = [
  http.get('*/v1/profiles/:profileId/sessions', () => ok([])),
  http.get('*/v1/profiles/:profileId/activities', () => ok([])),
  http.get('*/v1/profiles/:profileId/channels', () => ok([])),
  http.get('*/v1/profiles/:profileId/contacts', () => ok([])),
  http.get('*/v1/profiles/:profileId/memories', () => ok([])),
  http.get('*/v1/profiles/:profileId/deliveries', () => ok([])),
  http.get('*/v1/groups', () => ok([])),
  http.get('*/v1/providers', () => ok([])),
  http.get('*/v1/profiles/:profileId/activity', () => ok([])),
  ...handlers,
];

/** An update just landed: the release dialog opens over the page. */
export const updatedHandlers = [http.get('*/v1/releases', () => ok(data.releases)), ...handlers];
