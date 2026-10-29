// @vitest-environment node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { apiPath, forward } from './gateway';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
});

async function gateway(handler: Handler): Promise<string> {
  const server = createServer(handler);

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function echo(request: IncomingMessage, response: ServerResponse) {
  let body = '';

  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ url: request.url, headers: request.headers, body }));
  });
}

describe('the door from the web server to the gateway', () => {
  it('keeps an escaped slash inside its segment and the query as sent', async () => {
    const origin = await gateway(echo);
    const path = apiPath(['profiles', 'p1', 'mcp-servers', 'a/b c', 'check']);

    const response = await forward(
      new Request('http://panel.test/ignored?after=3&q=%2F', { method: 'POST', body: '{"a":1}' }),
      path,
      origin,
    );

    await expect(response.json()).resolves.toMatchObject({
      url: '/v1/profiles/p1/mcp-servers/a%2Fb%20c/check?after=3&q=%2F',
      body: '{"a":1}',
    });
  });

  it('passes the panel cookie and its CSRF header on, and drops per-hop headers', async () => {
    const origin = await gateway(echo);

    const response = await forward(
      new Request('http://panel.test/v1/profiles', {
        headers: {
          cookie: 'jian_panel=synthetic',
          'x-jian-panel': '1',
          host: 'panel.test',
          connection: 'keep-alive, x-hop',
          'x-hop': 'one hop only',
          'proxy-authorization': 'Basic c3ludGhldGlj',
        },
      }),
      '/v1/profiles',
      origin,
    );
    const { headers } = await response.json();

    expect(headers).toMatchObject({
      cookie: 'jian_panel=synthetic',
      'x-jian-panel': '1',
      'x-forwarded-host': 'panel.test',
    });
    expect(headers.host).toBe(new URL(origin).host);
    expect(headers).not.toHaveProperty('x-hop');
    expect(headers).not.toHaveProperty('proxy-authorization');
  });

  it("hands the gateway's redirect and every cookie it sets to the browser", async () => {
    const origin = await gateway((_request, response) => {
      response.writeHead(302, {
        location: '/integrations?github=installed',
        'set-cookie': ['jian_panel=synthetic; Path=/; HttpOnly', 'other=1; Path=/'],
      });
      response.end();
    });

    const response = await forward(
      new Request('http://panel.test/v1/integrations/github/callback'),
      '/v1/integrations/github/callback',
      origin,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/integrations?github=installed');
    expect(response.headers.getSetCookie()).toEqual([
      'jian_panel=synthetic; Path=/; HttpOnly',
      'other=1; Path=/',
    ]);
  });

  it('delivers each event as it is written, before the stream ends', async () => {
    const origin = await gateway((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      // Never ended: the panel's stream stays open for as long as the tab does.
    });
    const client = new AbortController();

    const response = await forward(
      new Request('http://panel.test/v1/profiles/p1/events/stream', { signal: client.signal }),
      '/v1/profiles/p1/events/stream',
      origin,
    );
    const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();

    await expect(reader?.read()).resolves.toEqual({ done: false, value: 'data: first\n\n' });
    client.abort();
  });

  it("closes the gateway's side when the browser goes away", async () => {
    let closed!: () => void;
    const gone = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const origin = await gateway((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': connected\n\n');
      response.on('close', closed);
    });
    const client = new AbortController();

    const response = await forward(
      new Request('http://panel.test/v1/profiles/p1/events/stream', { signal: client.signal }),
      '/v1/profiles/p1/events/stream',
      origin,
    );

    await response.body?.getReader().read();
    client.abort();

    // Otherwise every closed tab would keep one of the gateway's event streams counted.
    await expect(gone).resolves.toBeUndefined();
  });

  it('answers 502 when the gateway is not listening', async () => {
    const origin = await gateway(echo);

    await new Promise((resolve) => servers.pop()?.close(resolve));

    const response = await forward(
      new Request('http://panel.test/v1/profiles'),
      '/v1/profiles',
      origin,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'The gateway is not reachable.' });
  });
});
