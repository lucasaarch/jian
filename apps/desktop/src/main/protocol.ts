import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import type { GatewayStore } from './gateways/store';

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

  const headers = new Headers(request.headers);
  for (const name of DROPPED_REQUEST) headers.delete(name);
  headers.set('authorization', `Bearer ${store.token(gateway)}`);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  try {
    const response = await net.fetch(`${gateway.url}${path}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? request.body : null,
      // A streamed request body must say it may be read while the response starts.
      ...(hasBody ? { duplex: 'half' } : {}),
      redirect: 'manual',
    } as RequestInit);
    // The window keeps no cookie of any gateway: the token is the only credential.
    const answered = new Headers(response.headers);
    answered.delete('set-cookie');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: answered,
    });
  } catch {
    return Response.json({ error: 'The gateway did not answer.' }, { status: 502 });
  }
}
