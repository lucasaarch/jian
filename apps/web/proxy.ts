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
    // A file attached in the composer previews from a blob address the panel creates for it,
    // before it is sent: the picture, the voice note, and the read that draws its waveform and
    // finds its length. Only this origin can mint one, so `blob:` admits nothing from outside.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' blob:",
    // Videos and voice notes play from data addresses the panel builds from an attachment it
    // already fetched through the API.
    "media-src 'self' data: blob:",
    // The viewer opens a PDF from a blob address the panel itself creates, in a frame. That
    // document inherits this policy, and the browser's reader draws it as an embedded object,
    // so both have to accept the panel's own blobs or the page stays blank.
    "frame-src 'self' blob:",
    "object-src 'self' blob:",
    "worker-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    // Registering the GitHub App posts its manifest to github.com, the one way GitHub accepts
    // one. That is the only other place a form of this panel may be sent.
    "form-action 'self' https://github.com",
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
        '/((?!v1/|health$|openapi\\.json$|web/health$|_next/|robots\\.txt$|sw\\.js$|manifest\\.webmanifest$|brand/|favicon\\.ico$|icon\\.png$|apple-icon\\.png$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
