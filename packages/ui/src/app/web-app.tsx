'use client';

import { useQuery } from '@tanstack/react-query';
import { LogOut, Settings } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Mark } from '../components/ui';
import { useGatewayMode } from '../lib/gateway-mode';
import { agentPath } from '../lib/navigation';
import { queries, useProfiles } from '../lib/query/profile';
import { useVisibleViewport } from '../lib/viewport';
import { useSignOut, useWorkingAgentId } from '../lib/workspace';
import { NavigationAt, usePathname, useRouter, useSearchParams } from '../platform/navigation';
import { AppSettings } from './app-settings';
import { ChatsApp } from './chats';
import { useAppCommands } from './commands/app-commands';
import { type AppCommand, CommandsProvider, isMac, useCommands } from './commands/registry';
import { CreateAgent } from './create-agent';
import { ReleaseNotes } from './release-notes';
import { ReloadCurtain } from './reload';
import { barButton, SidebarBar } from './sidebar-bar';
import { settingsOf } from './web-addresses';

const noSubscription = () => () => {};

/**
 * The web's panel: the app's chats with their pages and overlays, behind a signed-in session.
 * Its settings have addresses, `/settings/:page`, drawn over the chat that was open, or over the
 * agent's chats when the address was opened by itself.
 */
export function WebApp() {
  const router = useRouter();
  // A signed cookie from an earlier visit is enough to walk straight back in.
  const profiles = useProfiles();
  useVisibleViewport();

  useEffect(() => {
    if (profiles.isError) router.replace('/sign-in');
  }, [profiles.isError, router]);

  if (!profiles.data) {
    return (
      <>
        <ReloadCurtain />
        <main
          className="grid h-dvh place-items-center bg-canvas"
          aria-busy="true"
          aria-label="Checking the session"
        >
          <span className="size-11 animate-pulse text-ink/80 [&_svg]:size-full">
            <Mark />
          </span>
        </main>
      </>
    );
  }

  return (
    <CommandsProvider browser>
      <ReloadCurtain />
      <SignedIn />
    </CommandsProvider>
  );
}

function SignedIn() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const href = search ? `${pathname}?${search}` : pathname;
  const working = useWorkingAgentId();
  const settings = settingsOf(pathname);
  const overlay = settings !== undefined;
  // What was open before an overlay's address, to draw beneath it and to go back to.
  const [under, setUnder] = useState<string>();
  useEffect(() => {
    if (!overlay) setUnder(href);
  }, [overlay, href]);
  const behind = under ?? (working ? agentPath(working, 'sessions') : '/');

  const [creating, setCreating] = useState(false);
  const signOut = useSignOut();
  const gateway = useQuery(queries.gateway()).data;
  const mode = useGatewayMode();
  const host = useSyncExternalStore(
    noSubscription,
    () => window.location.host,
    () => '',
  );
  const shortcut = useSyncExternalStore(
    noSubscription,
    () => (isMac() ? '⌘K' : 'Ctrl+K'),
    () => '⌘K',
  );

  const openSettings = useCallback(
    (page?: string) => router.push(page ? `/settings/${page}` : '/settings'),
    [router],
  );
  useAppCommands(openSettings);
  useCommands(
    'web',
    useMemo<AppCommand[]>(
      () => [
        {
          id: 'sign-out',
          title: 'Sign out',
          keywords: ['log out', 'leave', 'session'],
          icon: <LogOut size={15} />,
          run: () => void signOut(),
        },
      ],
      [signOut],
    ),
  );

  return (
    // The bar over the sidebar's top keeps this much clear; a phone adds its status bar.
    <div className="[--chrome-top:2.75rem] phone:[--chrome-top:calc(2.75rem+env(safe-area-inset-top))]">
      <NavigationAt href={overlay ? behind : href}>
        <ChatsApp
          createAgent={() => setCreating(true)}
          header={
            <header className="absolute top-0 left-0 z-30 flex h-(--chrome-top) phone:right-0 phone:pt-[env(safe-area-inset-top)]">
              <SidebarBar
                leading={<div className="w-1.5 shrink-0" />}
                shortcuts={{ search: shortcut }}
                trailing={
                  <button
                    type="button"
                    className={barButton}
                    onClick={() => openSettings()}
                    aria-label="Settings"
                    title="Settings"
                  >
                    <Settings size={15} />
                  </button>
                }
              />
            </header>
          }
        />
      </NavigationAt>
      <CreateAgent open={creating} onOpenChange={setCreating} />
      <AppSettings
        open={settings !== undefined}
        onOpenChange={(open) => !open && router.replace(behind)}
        page={settings || 'general'}
        onPageChange={(page) => router.replace(`/settings/${page}`)}
        grouped={false}
        host={{
          version: gateway?.version ?? 'unknown',
          signOut: () => void signOut(),
        }}
        gateway={{
          info: {
            id: 'web',
            name: host || 'Gateway',
            local: mode === 'local',
            url: host,
            state: 'Connected',
            ...(gateway?.version ? { version: gateway.version } : {}),
          },
        }}
      />
      <ReleaseNotes />
    </div>
  );
}
