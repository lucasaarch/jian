import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import { Notifications } from '../components/shell/notice';
import { QueryProvider } from '../components/shell/query';
import { ServiceWorker } from '../components/shell/service-worker';
import { ThemeSync } from '../components/shell/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jian · Gateway',
  description: 'Configure your agents, their channels and their connections in one place.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Jian' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#050505', colorScheme: 'dark light' };

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // The script policy carries a nonce minted per request (proxy.ts), and Next can only stamp
  // it on a page rendered for that request; a page prerendered at build time would be blocked.
  await connection();

  return (
    <html lang="en">
      <body>
        <QueryProvider>{children}</QueryProvider>
        <ThemeSync />
        <Notifications />
        <ServiceWorker />
      </body>
    </html>
  );
}
