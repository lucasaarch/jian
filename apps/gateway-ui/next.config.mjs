import { fileURLToPath } from 'node:url';

// What helmet used to put on every page the gateway served. The policy that names scripts is
// per request and lives in proxy.ts; these never change.
const SECURITY_HEADERS = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'Origin-Agent-Cluster', value: '?1' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Strict-Transport-Security', value: 'max-age=15552000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
  {
    key: 'X-Robots-Tag',
    value: 'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate',
  },
];

export default function configuration() {
  return {
    output: 'standalone',
    // The workspace packages live above this app; tracing from here alone would leave
    // @jian/contracts and @jian/sdk out of the standalone tree.
    outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
    poweredByHeader: false,
    images: { unoptimized: true },
    devIndicators: false,
    async headers() {
      return [{ source: '/:path*', headers: SECURITY_HEADERS }];
    },
  };
}
