/**
 * Which failures of a model call are worth waiting out, and why each failed, in words safe to show
 * and log. Read from statuses, codes and kinds, never from a message, which can quote the request
 * or the address.
 */

/**
 * Answers that say the provider could not take the call now, rather than that the call is wrong:
 * timeouts, Anthropic's lock conflict (409), too early, rate limits, server errors and overload.
 * A 429 must also say it is a rate limit (`rateLimited`): any other is a refusal.
 */
const RETRIED_STATUS: Record<number, string> = {
  408: 'request timeout',
  409: 'conflict',
  425: 'too early',
  429: 'rate limited',
  500: 'server error',
  502: 'bad gateway',
  503: 'unavailable',
  504: 'gateway timeout',
  529: 'overloaded',
};

/**
 * The status a stream error stands for when it names its kind and no status, as OpenAI-style
 * servers send one in the stream after a 200.
 */
const KIND_STATUS: Record<string, number> = {
  server_error: 500,
  rate_limit_exceeded: 429,
  rate_limit_error: 429,
  overloaded: 529,
  overloaded_error: 529,
};

/** The kinds of error body that say a 429 is a rate limit, on Anthropic and OpenAI. */
const RATE_LIMIT_KINDS = new Set(['rate_limit_error', 'rate_limit_exceeded']);
/**
 * Kinds that say nothing about which 429 it is: Anthropic's envelope, and the bare `error` a
 * subscription answers with. Beside them the headers decide.
 */
const VAGUE_KINDS = new Set(['error', 'api_error']);

/**
 * Failures before any response, by their system or undici code, in words for the owner.
 *
 * `ENOTFOUND` and `ECONNREFUSED` are retried without end too, by the owner's choice: an outage
 * looks like them, so a misspelled provider address waits for a Cancel rather than failing.
 *
 * Of TLS, only a handshake that timed out and a record corrupted in transit: a certificate the
 * client refuses, a CA it does not know, or a protocol version the server will not speak heal by
 * no amount of waiting, and a run would wait on them for ever.
 */
const NETWORK_CODES: Record<string, string> = {
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  ETIMEDOUT: 'connection timed out',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ECONNABORTED: 'connection reset',
  EPIPE: 'connection reset',
  // Undici's "other side closed": the socket hung up before the response.
  UND_ERR_SOCKET: 'connection reset',
  EAI_AGAIN: 'DNS lookup failed',
  ENOTFOUND: 'DNS lookup failed',
  ENETUNREACH: 'network unreachable',
  EHOSTUNREACH: 'network unreachable',
  ENETDOWN: 'network unreachable',
  EHOSTDOWN: 'network unreachable',
  ERR_TLS_HANDSHAKE_TIMEOUT: 'TLS handshake timed out',
  ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC: 'TLS record corrupted',
  ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC: 'TLS record corrupted',
  UND_ERR_HEADERS_TIMEOUT: 'no response in time',
};

type Link = Record<string, unknown>;

/** Every object an error was raised from, itself first, stopping at a cycle. */
function chain(error: unknown): Link[] {
  const links: Link[] = [];
  let cursor = error;
  while (cursor && typeof cursor === 'object' && !links.includes(cursor as never)) {
    links.push(cursor as Link);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return links;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

/** How long the provider asked to be left alone, in ms, from its response headers. */
function retryAfter(headers: Link | undefined, now: number): number | undefined {
  // Anthropic's own header is the precise one; `retry-after` is whole seconds or a date.
  const precise = text(headers?.['retry-after-ms']);
  if (precise && Number.isFinite(Number(precise)) && Number(precise) >= 0) return Number(precise);
  const after = text(headers?.['retry-after'])?.trim();
  if (!after) return undefined;
  const seconds = Number(after);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(after);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * The kinds an error names, from the link itself (a stream error part) or the body it carries:
 * the parsed `data` when the provider parsed it, else `responseBody`, parsed once here.
 */
function kindsOf(link: Link): string[] {
  let body = link.data;
  if (body === undefined && typeof link.responseBody === 'string') {
    try {
      body = JSON.parse(link.responseBody);
    } catch {
      body = undefined;
    }
  }
  const inner = (body as { error?: Link } | undefined)?.error;
  return [link.type, link.code, inner?.type, inner?.code].filter(
    (kind): kind is string => typeof kind === 'string',
  );
}

/**
 * Whether a 429 is a rate limit, which passes with time, rather than a refusal: a spent quota, a
 * billing or permission error, or the bare 429 Anthropic answers a malformed subscription request
 * with. A body that names its kind decides, since a spent quota can carry rate-limit headers too;
 * a body that names none leaves it to the headers.
 */
function rateLimited(link: Link): boolean {
  const kinds = kindsOf(link).filter((kind) => !VAGUE_KINDS.has(kind));
  if (kinds.length) return kinds.some((kind) => RATE_LIMIT_KINDS.has(kind));
  const headers = link.responseHeaders as Link | undefined;
  return Object.keys(headers ?? {}).some(
    (name) =>
      name === 'retry-after' ||
      name === 'retry-after-ms' ||
      name.startsWith('anthropic-ratelimit-') ||
      name.startsWith('x-ratelimit-'),
  );
}

/**
 * Whether a failed model call may be tried again, and why it failed. A status anywhere in the
 * chain decides, so a refusal is never retried for the network code beside it. Anything else, a
 * 400 for a context too large among them, fails as it always did.
 */
export function retryable(error: unknown): { reason: string; afterMs?: number } | undefined {
  const links = chain(error);
  for (const link of links) {
    if (typeof link.statusCode === 'number') {
      const said = RETRIED_STATUS[link.statusCode];
      if (!said || (link.statusCode === 429 && !rateLimited(link))) return undefined;
      const afterMs = retryAfter(link.responseHeaders as Link | undefined, Date.now());
      return {
        reason: `HTTP ${link.statusCode}, ${said}`,
        ...(afterMs !== undefined ? { afterMs } : {}),
      };
    }
    const kind = [link.code, link.type].find(
      (value): value is string => typeof value === 'string' && value in KIND_STATUS,
    );
    if (kind) return { reason: RETRIED_STATUS[KIND_STATUS[kind] ?? 500] ?? 'server error' };
  }
  for (const link of links) {
    const codes = [
      ...(typeof link.code === 'string' ? [link.code] : []),
      // safeFetch's codes, which stand in for the cause it does not keep.
      ...(Array.isArray(link.codes) ? link.codes.filter((code) => typeof code === 'string') : []),
    ];
    for (const code of codes) {
      const reason = NETWORK_CODES[code];
      if (reason) return { reason };
    }
  }
  return undefined;
}
