import type { Metadata } from 'next';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/ibm-plex-mono/400.css';
import { Notifications } from '../components/shell/notice';
import { preferencesBootstrap } from '../lib/preferences';
import { themeBootstrap } from '../lib/themes';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jian · Gateway',
  description: 'Configure your agents, their channels and their connections in one place.',
  icons: { icon: '/ui/brand/jian.svg', apple: '/ui/brand/apple-touch-icon.png' },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="strelizia" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Fixed theme allowlist only, hashed by the gateway CSP; must run before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap + preferencesBootstrap }} />
      </head>
      <body>
        {children}
        <Notifications />
      </body>
    </html>
  );
}
