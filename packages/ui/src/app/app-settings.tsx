'use client';

import {
  Cable,
  Cpu,
  Keyboard,
  KeyRound,
  Link2,
  Monitor,
  Palette,
  Plug,
  Settings2,
} from 'lucide-react';
import { Suspense, useState } from 'react';
import { Overlay, SettingsLayout, type SettingsPage } from '../kit';
import { useOnboarding } from '../lib/stores/onboarding';
import { Appearance } from './appearance';
import { type GatewayActions, GatewayConnection, type GatewayInfo } from './gateway-connection';
import { GatewayPage, type GatewayPageId, GatewayPageWaiting } from './gateway-pages';
import { type AppHost, GeneralSettings } from './general-settings';
import { KeymapsPage } from './settings/keymaps-page';
import type { ThisComputer } from './settings/machines-page';

export type { AppHost } from './general-settings';

/** The gateway in use, whose own settings sit under the app's: read through its connection. */
export type GatewaySettings = {
  info: GatewayInfo;
  /** How the host reaches it, for a host that keeps gateways: the web is served by its own. */
  actions?: GatewayActions;
  /** The computer the app runs on, as a machine of this gateway: only an app that is one. */
  thisComputer?: ThisComputer;
};

type Page = 'general' | 'appearance' | 'keymaps' | GatewayPageId | 'connection';

/**
 * Settings, from ⌘, or the status bar's gear: the app's own, and under them the gateway in use's,
 * named by it, so it is plain which change stays on this computer and which reaches the gateway.
 * Without a gateway to read — none chosen, one of another release — only the app's are there.
 */
export function AppSettings({
  open,
  onOpenChange,
  host,
  gateway,
  page: asked,
  onPageChange,
  grouped = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: AppHost;
  gateway?: GatewaySettings;
  /**
   * The page open, for a host that keeps it itself — the web, in its address — with what to do
   * when another is picked. Without it the overlay keeps its own, starting on General.
   */
  page?: string;
  onPageChange?: (page: string) => void;
  /**
   * Whether the app's pages and the gateway's are listed apart, under their names: where an app
   * keeps several gateways it tells them apart. The web is its gateway's alone, and lists one.
   */
  grouped?: boolean;
}) {
  const showOnboarding = useOnboarding((state) => state.show);
  const [own, setOwn] = useState<string>('general');
  const page = asked ?? own;
  const listed = [...appPages, ...(gateway ? gatewayPages(gateway) : [])];
  const pages = grouped ? listed : listed.map(({ group: _group, ...item }) => item);
  // A page of a gateway that is no longer in use, or that this one does not have, is not shown.
  const current = (pages.some((item) => item.id === page) ? page : 'general') as Page;

  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Settings" closeButton={false}>
      <SettingsLayout
        pages={pages}
        current={current}
        onSelect={onPageChange ?? setOwn}
        // A page named by the host was asked for by name: a phone opens on it, not on the list.
        startOnPage={asked !== undefined && asked !== 'general'}
      >
        <PageOf
          page={current}
          host={host}
          gateway={gateway}
          showOnboarding={() => {
            onOpenChange(false);
            showOnboarding();
          }}
        />
      </SettingsLayout>
    </Overlay>
  );
}

function PageOf({
  page,
  host,
  gateway,
  showOnboarding,
}: {
  page: Page;
  host: AppHost;
  gateway: GatewaySettings | undefined;
  showOnboarding: () => void;
}) {
  if (page === 'general')
    return (
      <GeneralSettings
        host={host}
        gateway={Boolean(gateway)}
        {...(gateway ? { showOnboarding } : {})}
      />
    );
  if (page === 'appearance') return <Appearance />;
  if (page === 'keymaps') return <KeymapsPage />;
  if (!gateway) return null;
  if (page === 'connection') {
    if (!gateway.actions) return null;
    return (
      <GatewayConnection key={gateway.info.id} gateway={gateway.info} host={gateway.actions} />
    );
  }
  // A gateway's page reads it first; while it does, the page's place holds the page's shape.
  return (
    <Suspense fallback={<GatewayPageWaiting page={page} />}>
      <GatewayPage
        key={`${gateway.info.id}-${page}`}
        page={page}
        thisComputer={gateway.thisComputer}
      />
    </Suspense>
  );
}

const APP = 'App';

const appPages: SettingsPage[] = [
  {
    id: 'general',
    label: 'General',
    icon: <Settings2 size={15} />,
    group: APP,
    keywords: [
      'startup',
      'login',
      'version',
      'updates',
      'release',
      'notes',
      'github',
      'sign out',
      'onboarding',
      'welcome',
    ],
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: <Palette size={15} />,
    group: APP,
    keywords: ['theme', 'dark', 'light'],
  },
  {
    id: 'keymaps',
    label: 'Keymaps',
    icon: <Keyboard size={15} />,
    group: APP,
    keywords: ['keyboard', 'shortcut', 'binding', 'command'],
  },
];

/**
 * The gateway's pages, under its name; one on this computer has no machines to control, and one
 * the host does not keep has no connection of its own to show.
 */
function gatewayPages({ info, actions }: GatewaySettings): SettingsPage[] {
  const group = info.name;
  return [
    {
      id: 'providers',
      label: 'Providers',
      icon: <Plug size={15} />,
      group,
      keywords: ['openai', 'anthropic', 'key', 'subscription', 'chatgpt'],
    },
    {
      id: 'models',
      label: 'Capabilities',
      icon: <Cpu size={15} />,
      group,
      keywords: ['model', 'audio', 'voice', 'speech', 'image', 'channel', 'compaction', 'defaults'],
    },
    {
      id: 'integrations',
      label: 'Integrations',
      icon: <Cable size={15} />,
      group,
      keywords: ['github', 'mcp', 'app', 'server'],
    },
    {
      id: 'ssh-keys',
      label: 'SSH keys',
      icon: <KeyRound size={15} />,
      group,
      keywords: ['ssh', 'key', 'git', 'server'],
    },
    ...(info.local
      ? []
      : [
          {
            id: 'machines',
            label: 'Machines',
            icon: <Monitor size={15} />,
            group,
            keywords: ['machine', 'computer', 'worker', 'remote', 'control', 'this computer'],
          },
        ]),
    ...(actions
      ? [
          {
            id: 'connection',
            label: 'Connection',
            icon: <Link2 size={15} />,
            group,
            keywords: ['address', 'version', 'token', 'remove', 'gateway'],
          },
        ]
      : []),
  ];
}
