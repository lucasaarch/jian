import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { WebSearch } from '../src/web/service.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-web-admin-token-32-characters';
const admin = { authorization: `Bearer ${token}` };
const model = { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };

const call = async (tool: unknown, input: unknown) =>
  (tool as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 'test',
    messages: [],
    context: {},
  });

async function setup(respond: (url: string, init?: RequestInit) => Response) {
  const services = await testServices();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const web = new WebSearch(services.store, services.gatewayVault, async (input, init) => {
    requests.push({ url: String(input), ...(init ? { init } : {}) });

    return respond(String(input), init);
  });
  const runFor = async (allowWebSearch: boolean) => {
    const profile = await services.profiles.createProfile({
      name: 'Zero Two',
      instructions: 'Help.',
      model,
      allowWebSearch,
    });
    const session = await services.sessions.createSession(profile.id, { title: 'Web' });

    return services.runs.submit(profile.id, session.id, { text: 'Oi', requestKey: 'one' });
  };

  return { services, web, requests, runFor };
}

const tavily = () =>
  Response.json({
    results: [{ title: 'JEV agent', url: 'https://example.com/jev', content: 'JEV is an agent.' }],
  });

describe('searching the web', () => {
  it('hands out nothing unless the owner switched it on for this profile', async () => {
    const { web, runFor } = await setup(tavily);

    expect(web.tools(await runFor(false))).toEqual({});
    expect(Object.keys(web.tools(await runFor(true)))).toEqual(['web_search', 'fetch_url']);
  });

  it('asks for the key before searching, and sends it only to the search service', async () => {
    const { web, requests, runFor } = await setup(tavily);
    const tools = web.tools(await runFor(true));
    const input = { query: 'o que é JEV', maxResults: 5, topic: 'general' };

    await expect(call(tools.web_search, input)).rejects.toThrow('not configured');

    await web.configure({ provider: 'tavily', apiKey: 'tvly-synthetic' });

    expect(await call(tools.web_search, input)).toEqual({
      results: [
        { title: 'JEV agent', url: 'https://example.com/jev', snippet: 'JEV is an agent.' },
      ],
    });
    expect(requests[0]?.url).toBe('https://api.tavily.com/search');
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe(
      'Bearer tvly-synthetic',
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      query: 'o que é JEV',
      max_results: 5,
    });
  });

  it('says a refused key in words, without echoing what the service answered', async () => {
    const { web, runFor } = await setup(
      () => new Response('{"detail":"tvly-synthetic"}', { status: 401 }),
    );
    const tools = web.tools(await runFor(true));

    await web.configure({ provider: 'tavily', apiKey: 'tvly-synthetic' });

    await expect(
      call(tools.web_search, { query: 'x y', maxResults: 1, topic: 'general' }),
    ).rejects.toThrow('The search service refused the key');
  });

  it('reads a page as text, a slice at a time, and refuses what is not text', async () => {
    const html = `<html><head><title>JEV &amp; co</title><style>p{}</style></head><body><script>evil()</script><p>Primeiro</p><p>${'a'.repeat(25_000)}</p></body></html>`;
    const { web, runFor } = await setup((url) =>
      url === 'http://example.com/jev'
        ? new Response(null, { status: 301, headers: { location: 'https://example.com/jev' } })
        : url.endsWith('.png')
          ? new Response('x', { headers: { 'content-type': 'image/png' } })
          : new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    );
    const tools = web.tools(await runFor(true));

    const first = (await call(tools.fetch_url, { url: 'http://example.com/jev', offset: 0 })) as {
      url: string;
      title: string;
      text: string;
      more?: string;
    };

    expect(first.url).toBe('https://example.com/jev');
    expect(first.title).toBe('JEV & co');
    expect(first.text.startsWith('Primeiro\n')).toBe(true);
    expect(first.text).not.toContain('evil');
    expect(first.more).toContain('offset 20000');

    await expect(
      call(tools.fetch_url, { url: 'https://example.com/a.png', offset: 0 }),
    ).rejects.toThrow('only text pages');
  });
});

describe('the web search key', () => {
  it('is set, reported and removed by the owner, and never read back', async () => {
    const services = await testServices();
    const app = createApp({ ...services, token, logger: false });

    try {
      expect((await app.inject({ url: '/v1/web-search' })).statusCode).toBe(401);

      const set = await app.inject({
        method: 'PUT',
        url: '/v1/web-search',
        headers: admin,
        payload: { provider: 'tavily', apiKey: 'tvly-synthetic' },
      });

      expect(set.statusCode).toBe(200);
      expect(set.json()).toMatchObject({ provider: 'tavily', configured: true });
      expect(set.body).not.toContain('tvly-synthetic');

      const removed = await app.inject({ method: 'DELETE', url: '/v1/web-search', headers: admin });

      expect(removed.json()).toEqual({ provider: 'tavily', configured: false });
    } finally {
      await app.close();
    }
  });
});
