import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import { Notifications, QueryProvider, ThemeSync, VersionMismatch } from '@jian/ui';
import { versionMismatch } from '../lib/server/versions';
import './globals.css';
import { NextNavigation } from './navigation';
import { ServiceWorker } from './service-worker';

export const metadata: Metadata = {
  title: 'Jian · Gateway',
  description: 'Configure your agents, their channels and their connections in one place.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Jian' },
  robots: { index: false, follow: false },
};

// Edge to edge on a phone, as an installed app draws under the status bar anyway: the shell
// pads itself by the safe areas instead of leaving the corners to cut into it.
export const viewport: Viewport = {
  themeColor: '#050505',
  colorScheme: 'dark light',
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The script policy carries a nonce minted per request (proxy.ts), and Next can only stamp
  // it on a page rendered for that request; a page prerendered at build time would be blocked.
  await connection();
  const mismatch = await versionMismatch();

  return (
    <html lang="en">
      <body>
        {mismatch ? (
          <VersionMismatch {...mismatch} />
        ) : (
          <QueryProvider>
            <NextNavigation>{children}</NextNavigation>
          </QueryProvider>
        )}
        <ThemeSync />
        <Notifications />
        <ServiceWorker />
      </body>
    </html>
  );
}
