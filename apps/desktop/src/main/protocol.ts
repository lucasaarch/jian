import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JIAN_CLIENT_HEADER, JIAN_DESKTOP_CLIENT } from '@jian/contracts';
import { net, protocol } from 'electron';
import { answerHeaders } from './answer-headers';
import { frameRequest } from './frame-requests';
import { logConnections, stalled } from './gateways/connections';
import type { GatewayStore } from './gateways/store';
import { type BodyEnd, releasing } from './release-body';

/**
 * The window loads from jian://app, and reaches each gateway under jian://app/gateway/<id>: one
 * origin, so the panel works as it does behind the web host, with no CORS. The main process signs
 * each request with the gateway's token, which the window never holds.
 */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'jian',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** What a gateway answers to the panel: its API, and the two documents the web host passes too. */
const FORWARDED = /^\/(v1\/.*|health|openapi\.json)$/;

/** Headers the gateway decides from its own address, or that would sign the request twice. */
const DROPPED_REQUEST = ['host', 'origin', 'referer', 'cookie', 'authorization'];

/**
 * How long a gateway may take to start answering, in ms. Every read of the panel gives up after
 * 30 seconds, but its giving up never reaches this process before the answer starts: without a
 * limit of its own, a request on a connection that stopped carrying anything waits here forever.
 */
const ANSWER_MS = 60_000;
/** How long an answer under way may send nothing, in ms. An event stream speaks every 25. */
const SILENT_MS = 90_000;
/** How long the window may leave an event stream unread before it is taken as abandoned, in ms. */
const UNREAD_MS = 90_000;

const seconds = (since: number) => `${Math.round((Date.now() - since) / 1000)}s`;
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function handleScheme(store: GatewayStore, renderer: { dir: string; devServer?: string }) {
  protocol.handle('jian', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });

    const gateway = /^\/gateway\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (gateway) return forward(store, gateway[1] ?? '', gateway[2] ?? '/', url, request);

    // In development the panel comes from Vite's server, which also brings hot reload.
    if (renderer.devServer)
      return net.fetch(new URL(url.pathname + url.search, renderer.devServer).href);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = join(renderer.dir, path);
    // Nothing outside the panel's own files is served, whatever the path says.
    if (!file.startsWith(renderer.dir)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
}

async function forward(
  store: GatewayStore,
  id: string,
  path: string,
  url: URL,
  request: Request,
): Promise<Response> {
  const gateway = store.get(id);
  if (!gateway)
    return Response.json({ error: 'This gateway was removed from the app.' }, { status: 404 });
  if (!FORWARDED.test(path)) return new Response('Not found', { status: 404 });

  // Untrusted Artifact frames can be sent here; they never get the gateway's token.
  const verdict = frameRequest(path, request.headers);
  if (verdict === 'refuse') return new Response('Forbidden', { status: 403 });

  const headers = new Headers(request.headers);
  for (const name of DROPPED_REQUEST) headers.delete(name);
  if (verdict === 'sign') headers.set('authorization', `Bearer ${store.token(gateway)}`);
  headers.set(JIAN_CLIENT_HEADER, JIAN_DESKTOP_CLIENT);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const gone = new AbortController();
  const host = new URL(gateway.url).host;
  const asked = `${request.method} ${path}`;
  const startedAt = Date.now();
  let late = false;
  const limit = setTimeout(() => {
    late = true;
    gone.abort();
  }, ANSWER_MS);
  try {
    const response = await net.fetch(`${gateway.url}${path}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      // The window's own fetch says no-store, which does not cross this hop by itself.
      cache: 'no-store',
      signal: gone.signal,
      // A streamed request body must say it may be read while the response starts.
      ...(hasBody ? { duplex: 'half' } : {}),
      redirect: 'manual',
    } as RequestInit);
    clearTimeout(limit);
    const answered = answerHeaders(response.headers);
    const stream = answered.get('content-type')?.startsWith('text/event-stream') ?? false;
    if (stream) logConnections(`${host} ${asked} opened`);
    const openedAt = Date.now();
    const ended = (how: BodyEnd, error?: unknown) => {
      if (how === 'silent') stalled(host, `${asked} went silent, open for ${seconds(openedAt)}`);
      else if (how === 'unread') logConnections(`${host} ${asked} left unread, let go`);
      else if (how === 'failed') logConnections(`${host} ${asked} failed: ${reason(error)}`);
      else if (stream) {
        const by = how === 'done' ? 'the gateway' : 'the window';
        logConnections(`${host} ${asked} closed by ${by} after ${seconds(openedAt)}`);
      }
    };
    const body =
      response.body &&
      releasing(response.body, () => gone.abort(), {
        silentMs: SILENT_MS,
        ...(stream ? { unreadMs: UNREAD_MS } : {}),
        ended,
      });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: answered,
    });
  } catch (error) {
    clearTimeout(limit);
    if (late) {
      stalled(host, `${asked} got no answer in ${seconds(startedAt)}`);
      return Response.json({ error: 'The gateway did not answer in time.' }, { status: 504 });
    }
    logConnections(`${host} ${asked} got no answer: ${reason(error)}`);
    return Response.json({ error: 'The gateway did not answer.' }, { status: 502 });
  }
}
