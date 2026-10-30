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

// Screens that moved out of the agent to the gateway's own settings. A bookmark of the old
// address lands on the new one.
const MOVED_TO_SETTINGS = ['providers', 'models', 'integrations', 'remote', 'ssh-keys'];

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
      return [
        ...MOVED_TO_SETTINGS.map((section) => ({
          source: `/agents/:profileId/${section}/:rest*`,
          destination: `/settings/${section}/:rest*`,
          permanent: false,
        })),
        // Projects are created and chosen in the composer; their screen is gone.
        {
          source: '/agents/:profileId/projects/:rest*',
          destination: '/agents/:profileId/sessions',
          permanent: false,
        },
      ];
    },
  };
}
