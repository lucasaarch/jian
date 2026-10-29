/**
 * The one door from this server to the gateway. The browser, webhook senders and remote
 * workers reach `/v1/*`, `/health`, `/openapi.json` and `/jian-remote.mjs` here, and the request is passed on byte for byte:
 * validation, authorization and rate limits stay in the gateway.
 *
 * Next's own external rewrite is not used on purpose: it cuts every proxied response at 30
 * seconds, which would end the panel's event stream, and it gives no say over which headers
 * cross.
 */

/** Where the gateway listens, seen from this server. Compose names the service `gateway`. */
function gatewayUrl(): string {
  return process.env.JIAN_GATEWAY_URL ?? 'http://127.0.0.1:4310';
}

// Per-connection headers (RFC 9110 §7.6.1) describe one hop and never cross a proxy. `host`
// is the gateway's own, which fetch sets.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

// fetch has already decoded the body it hands over, so its length and encoding no longer
// describe what is sent on; Node re-frames the stream.
const DECODED = new Set(['content-encoding', 'content-length']);

/** The gateway path of a `/v1/[...path]` request, from its catch-all segments. */
export function apiPath(segments: readonly string[]): string {
  // The segments arrive decoded; encoding each again keeps an escaped `/` inside its segment.
  return `/v1/${segments.map(encodeURIComponent).join('/')}`;
}

function connectionHeaders(headers: Headers): Set<string> {
  // `Connection: x-foo` makes `x-foo` hop-by-hop too.
  return new Set(
    (headers.get('connection') ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

function passable(headers: Headers, drop: ReadonlySet<string>): Headers {
  const named = connectionHeaders(headers);
  const result = new Headers();

  for (const [name, value] of headers) {
    if (!HOP_BY_HOP.has(name) && !drop.has(name) && !named.has(name)) {
      result.append(name, value);
    }
  }

  return result;
}

export async function forward(
  request: Request,
  path: string,
  origin = gatewayUrl(),
): Promise<Response> {
  const target = new URL(path, origin);

  target.search = new URL(request.url).search;

  const headers = passable(request.headers, new Set());
  const host = request.headers.get('host');

  // Next fills x-forwarded-for and -proto before this runs; the host is the one the browser
  // used, which fetch would otherwise replace with the gateway's.
  if (host && !headers.has('x-forwarded-host')) {
    headers.set('x-forwarded-host', host);
  }

  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body;

  let upstream: Response;

  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      // A redirect is the gateway's answer to the browser (an OAuth callback, for one), not
      // something this hop should follow.
      redirect: 'manual',
      // A closed tab must close the gateway's side too, or each event stream it held stays
      // counted against the gateway's limit.
      signal: request.signal,
      ...(body ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch (error) {
    if (request.signal.aborted) {
      throw error;
    }

    return Response.json({ error: 'The gateway is not reachable.' }, { status: 502 });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: passable(upstream.headers, DECODED),
  });
}
