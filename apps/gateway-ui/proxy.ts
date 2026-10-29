import { type NextRequest, NextResponse } from 'next/server';

/**
 * Each page gets a fresh nonce, and Next stamps it on every script it renders; nothing else
 * inline may run. This replaces the hashes the gateway read out of the static export.
 *
 * `'strict-dynamic'` is left out on purpose: it would void `'self'`, which the chunks and the
 * service worker load under.
 */
export function policy(nonce: string, development = process.env.NODE_ENV === 'development') {
  return [
    // React rebuilds server error stacks with eval in development only.
    `script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ''}`,
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    // Videos and voice notes play from data addresses the panel builds from an attachment it
    // already fetched through the API.
    "media-src 'self' data:",
    // The viewer opens a PDF from a blob address the panel itself creates, in a frame. That
    // document inherits this policy, and the browser's reader draws it as an embedded object,
    // so both have to accept the panel's own blobs or the page stays blank.
    "frame-src 'self' blob:",
    "object-src 'self' blob:",
    "worker-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const value = policy(nonce);
  // Next reads the nonce back out of the request's policy while it renders.
  const headers = new Headers(request.headers);

  headers.set('content-security-policy', value);

  const response = NextResponse.next({ request: { headers } });

  response.headers.set('content-security-policy', value);
  // A page carries a nonce that must never be replayed from a cache.
  response.headers.set('cache-control', 'no-store');

  return response;
}

export const config = {
  matcher: [
    {
      // Pages only. The gateway's paths, this server's own health check, Next's assets and
      // the files in public/ need no policy.
      source:
        '/((?!v1/|health$|openapi\\.json$|jian-remote\\.mjs$|web/health$|_next/|robots\\.txt$|sw\\.js$|manifest\\.webmanifest$|brand/|favicon\\.ico$|icon\\.png$|apple-icon\\.png$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
