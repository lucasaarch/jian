import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
// The agent and the request have to come from the same undici: Node bundles its own copy,
// and handing a dispatcher built here to Node's `fetch` pairs two versions that only agree by
// luck. On Node 24 they do not, and every outbound call fails on the handler interface.
import { Agent, fetch as undiciFetch } from 'undici';

const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.azure.internal',
  'instance-data',
  'instance-data.ec2.internal',
]);

const METADATA_ADDRESSES = new Set(['169.254.169.254', '100.100.100.200', 'fd00:ec2::254']);

function parsedAddress(address: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  try {
    return ipaddr.parse(address);
  } catch {
    return undefined;
  }
}

function isMetadataAddress(address: string): boolean {
  const parsed = parsedAddress(address);

  if (!parsed) {
    return false;
  }

  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    return isMetadataAddress(parsed.toIPv4Address().toString());
  }

  return parsed.range() === 'linkLocal' || METADATA_ADDRESSES.has(parsed.toString());
}

export function isPublicAddress(address: string): boolean {
  const parsed = parsedAddress(address);

  if (!parsed || isMetadataAddress(address)) {
    return false;
  }

  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    return isPublicAddress(parsed.toIPv4Address().toString());
  }

  return parsed.range() === 'unicast';
}

function isMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  return (
    METADATA_HOSTS.has(host) ||
    host.split('.').includes('metadata') ||
    host.startsWith('instance-data.')
  );
}

function parseEndpoint(input: string | URL): URL {
  const value = String(input);

  if (value.length === 0 || value.length > 8192) {
    throw new Error('Invalid outbound endpoint');
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid outbound endpoint');
  }

  const rawAuthority = value.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    value.includes('#') ||
    rawAuthority?.includes('@') ||
    isMetadataHost(url.hostname)
  ) {
    throw new Error('Outbound endpoint is not permitted');
  }

  const rawHost = rawAuthority
    ?.replace(/^.*@/, '')
    .replace(/^\[([^\]]+)\](?::\d+)?$/, '$1')
    .replace(/:\d+$/, '');

  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;

  if (isIP(hostname) === 4 && rawHost?.toLowerCase() !== hostname.toLowerCase()) {
    throw new Error('Ambiguous IP address is not permitted');
  }

  if (isIP(hostname) && isMetadataAddress(hostname)) {
    throw new Error('Metadata endpoint is not permitted');
  }

  return url;
}

function configuredOrigins(origins: readonly string[]): Set<string> {
  const allowed = new Set<string>();

  for (const origin of origins) {
    const url = parseEndpoint(origin);

    if (url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Private origin must be an exact origin');
    }

    allowed.add(url.origin);
  }

  return allowed;
}

export function validateEndpoint(
  input: string | URL,
  allowPrivateOrigins: readonly string[] = [],
): URL {
  const url = parseEndpoint(input);
  const allowed = configuredOrigins(allowPrivateOrigins).has(url.origin);

  if (url.protocol !== 'https:' && !allowed) {
    throw new Error('HTTPS is required for outbound requests');
  }

  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;

  if (isIP(hostname) && !isPublicAddress(hostname) && !allowed) {
    throw new Error('Private endpoint is not permitted');
  }

  return url;
}

export interface SafeFetchOptions {
  allowPrivateOrigins?: string[];
  lookup?: (hostname: string) => Promise<readonly string[]>;
}

/**
 * undici's own `fetch` does not take Node's global `Request`, so one is flattened into a URL
 * and an init. The body is read here because a stream cannot be handed to both.
 */
async function asUndiciRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<{ url: string; init: Record<string, unknown> }> {
  if (!(input instanceof Request)) {
    // Node's FormData is not the bundled undici's: handed over as is, it is sent as the text
    // "[object FormData]" with no multipart type, and an upload arrives empty. Encoded here by
    // Node's own Response, it goes as bytes with its boundary in the content type.
    if (init?.body instanceof FormData) {
      const encoded = new Response(init.body);
      const headers = new Headers(init.headers);

      headers.set('content-type', encoded.headers.get('content-type') ?? 'multipart/form-data');

      return {
        url: String(input),
        init: {
          ...(init as Record<string, unknown>),
          headers: Object.fromEntries(headers.entries()),
          body: Buffer.from(await encoded.arrayBuffer()),
        },
      };
    }

    return { url: String(input), init: (init ?? {}) as Record<string, unknown> };
  }

  const body = ['GET', 'HEAD'].includes(input.method) ? undefined : await input.arrayBuffer();

  return {
    url: input.url,
    init: {
      method: input.method,
      headers: Object.fromEntries(input.headers.entries()),
      ...(body && body.byteLength > 0 ? { body: Buffer.from(body) } : {}),
      ...((init ?? {}) as Record<string, unknown>),
    },
  };
}

/** The failure code of an error or of whatever it was raised from, and nothing else of it. */
function reason(error: unknown): string {
  const codes: string[] = [];
  let cursor = error;

  while (cursor instanceof Error && codes.length < 4) {
    const code = (cursor as { code?: unknown }).code;

    if (typeof code === 'string') {
      codes.push(code);
    }

    if (cursor.message) {
      codes.push(cursor.message.slice(0, 120));
    }

    cursor = cursor.cause;
  }

  return codes.length ? ` (${[...new Set(codes)].join(' · ')})` : '';
}

export function createSafeFetch(options: SafeFetchOptions = {}): {
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
} {
  const allowed = configuredOrigins(options.allowPrivateOrigins ?? []);
  const agents = new Map<string, Agent>();
  let closed = false;

  const safeFetch: typeof globalThis.fetch = async (input, init) => {
    if (closed) {
      throw new Error('Outbound client is closed');
    }

    const url = validateEndpoint(input instanceof Request ? input.url : input, [...allowed]);
    const allowPrivate = allowed.has(url.origin);
    let agent = agents.get(url.origin);

    if (!agent) {
      agent = new Agent({
        connect: {
          lookup(hostname, lookupOptions, callback) {
            const resolve = async () => {
              const addresses = options.lookup
                ? await options.lookup(hostname)
                : (await dns.lookup(hostname, { all: true })).map((answer) => answer.address);

              if (
                addresses.length === 0 ||
                addresses.some(
                  (address) =>
                    !parsedAddress(address) ||
                    isMetadataAddress(address) ||
                    (!allowPrivate && !isPublicAddress(address)),
                )
              ) {
                throw new Error('Outbound DNS address is not permitted');
              }

              const matching = addresses.filter(
                (address) => !lookupOptions.family || isIP(address) === lookupOptions.family,
              );

              if (matching.length === 0) {
                throw new Error('Outbound DNS family is unavailable');
              }

              return matching;
            };

            resolve().then(
              (addresses) => {
                if (lookupOptions.all) {
                  callback(
                    null,
                    addresses.map((address) => ({ address, family: isIP(address) })),
                  );
                } else {
                  const address = addresses[0];

                  if (address) {
                    callback(null, address, isIP(address));
                  }
                }
              },
              (error) => callback(error as Error, '', 0),
            );
          },
        },
      });

      agents.set(url.origin, agent);
    }

    try {
      const request = await asUndiciRequest(input, init);

      return (await undiciFetch(request.url, {
        ...request.init,
        // Never followed here: the next address has not been checked. A caller that asks for
        // `manual` gets the 3xx back and sends the next hop through this same guard.
        redirect: init?.redirect === 'manual' ? 'manual' : 'error',
        dispatcher: agent,
      })) as unknown as Response;
    } catch (error) {
      // The cause carries the address and can carry a credential, so only its code travels —
      // which is the part that says whether the host refused, resolved or timed out.
      throw new Error(`Outbound request failed${reason(error)}`);
    }
  };

  return {
    fetch: safeFetch,
    async close() {
      closed = true;
      await Promise.all([...agents.values()].map((agent) => agent.close()));
      agents.clear();
    },
  };
}
