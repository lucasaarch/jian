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

/**
 * Addresses of screens that moved, so a bookmark or an old notification lands where the screen
 * is now. The query goes along: GitHub's outcome rides on `/settings/integrations/github`.
 */
const MOVED = [
  // The gateway's screens left the agent for Settings, its integrations onto one page, and
  // Remote became Machines.
  ['/agents/:profileId/:page(providers|models|ssh-keys)/:rest*', '/settings/:page'],
  ['/agents/:profileId/integrations/:rest*', '/settings/integrations'],
  ['/agents/:profileId/remote/:rest*', '/settings/machines'],
  ['/settings/integrations/:rest+', '/settings/integrations'],
  ['/settings/remote', '/settings/machines'],
  // An agent's skills, memories and channels are the tabs of its Customize; who it is, its
  // settings over its chats.
  ['/agents/:profileId/:tab(skills|memories|channels)', '/agents/:profileId/customize/:tab'],
  ['/agents/:profileId/identity', '/agents/:profileId/settings'],
  // Projects are created and chosen in the composer; their screen is gone.
  ['/agents/:profileId/projects/:rest*', '/agents/:profileId/sessions'],
];

export default function configuration() {
  return {
    output: 'standalone',
    // The panel's screens ship as TypeScript source in @jian/ui, compiled with this app.
    transpilePackages: ['@jian/ui'],
    // The workspace packages live above this app; tracing from here alone would leave
    // @jian/contracts and @jian/sdk out of the standalone tree.
    outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
    poweredByHeader: false,
    images: { unoptimized: true },
    devIndicators: false,
    async headers() {
      return [{ source: '/:path*', headers: SECURITY_HEADERS }];
    },
    async redirects() {
      return MOVED.map(([source, destination]) => ({ source, destination, permanent: false }));
    },
  };
}
