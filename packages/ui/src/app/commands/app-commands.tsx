'use client';

import {
  Blocks,
  Cable,
  Cpu,
  Keyboard,
  KeyRound,
  Maximize2,
  Monitor,
  MoonStar,
  Palette,
  PanelLeft,
  PanelRight,
  Plug,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sun,
} from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { toggleInspector, toggleInspectorFull } from '../../components/sessions/inspector-host';
import { useThemeChoice } from '../../components/shell/theme';
import { reconnectGateway } from '../../lib/stores/reconnect';
import { reloadApp } from '../reload';
import { toggleSidebar } from '../sidebar-bar';
import { type AppCommand, useCommands } from './registry';

/** The settings pages a command opens straight to; a gateway without one shows General. */
const pages: { id: string; title: string; keywords: string[]; icon: ReactNode }[] = [
  {
    id: 'appearance',
    title: 'Appearance',
    keywords: ['theme', 'font', 'motion'],
    icon: <Palette size={15} />,
  },
  {
    id: 'keymaps',
    title: 'Keymaps',
    keywords: ['keyboard', 'shortcut', 'binding'],
    icon: <Keyboard size={15} />,
  },
  {
    id: 'providers',
    title: 'Providers',
    keywords: ['models', 'api key', 'anthropic', 'openai', 'connect'],
    icon: <Plug size={15} />,
  },
  {
    id: 'models',
    title: 'Capabilities',
    keywords: ['model', 'effort', 'default'],
    icon: <Cpu size={15} />,
  },
  {
    id: 'apps',
    title: 'Apps',
    keywords: ['github', 'x', 'twitter', 'account', 'connect', 'integrations'],
    icon: <Blocks size={15} />,
  },
  {
    id: 'mcp-servers',
    title: 'MCP servers',
    keywords: ['mcp', 'server', 'tools', 'connect', 'integrations'],
    icon: <Cable size={15} />,
  },
  {
    id: 'ssh-keys',
    title: 'SSH keys',
    keywords: ['ssh', 'git', 'key'],
    icon: <KeyRound size={15} />,
  },
  {
    id: 'machines',
    title: 'Machines',
    keywords: ['computer', 'remote', 'share', 'worker'],
    icon: <Monitor size={15} />,
  },
];

/**
 * The commands of the app around the chats, in every host: its settings and their pages, the
 * sidebar, the theme, reaching the gateway again. `openSettings` opens the overlay, on `page` when
 * one is named. A host that watches its gateways itself passes `reconnect` to look at once too.
 */
export function useAppCommands(
  openSettings: (page?: string) => void,
  reconnect?: () => void,
): void {
  const { theme, setTheme } = useThemeChoice();
  const commands = useMemo<AppCommand[]>(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    return [
      {
        id: 'settings',
        group: 'Settings',
        title: 'Open settings',
        keywords: ['preferences', 'options'],
        icon: <Settings2 size={15} />,
        keys: { key: ',' },
        run: () => openSettings(),
      },
      ...pages.map<AppCommand>((page) => ({
        id: `settings-${page.id}`,
        group: 'Settings',
        title: page.title,
        detail: 'Settings',
        keywords: ['settings', ...page.keywords],
        icon: page.icon,
        ...(page.id === 'keymaps' ? { keys: { key: ',', shift: true } } : {}),
        run: () => openSettings(page.id),
      })),
      {
        id: 'sidebar',
        group: 'View',
        title: 'Toggle sidebar',
        keywords: ['chats', 'list', 'hide', 'show', 'collapse'],
        icon: <PanelLeft size={15} />,
        keys: { key: 'b' },
        run: toggleSidebar,
      },
      {
        id: 'inspector',
        group: 'Inspector',
        title: 'Toggle inspector',
        keywords: ['browser', 'panel', 'side', 'tabs', 'pull request', 'subagent'],
        icon: <PanelRight size={15} />,
        keys: { key: 'b', shift: true },
        run: toggleInspector,
      },
      {
        id: 'inspector-full',
        group: 'Inspector',
        title: 'Toggle inspector full screen',
        keywords: ['browser', 'panel', 'maximize', 'expand', 'wide'],
        icon: <Maximize2 size={15} />,
        run: () => void toggleInspectorFull(),
      },
      {
        id: 'theme',
        group: 'View',
        keys: { key: 'l', shift: true },
        title: next === 'light' ? 'Switch to light theme' : 'Switch to dark theme',
        keywords: ['appearance', 'theme', 'dark', 'light', 'mode'],
        icon: next === 'light' ? <Sun size={15} /> : <MoonStar size={15} />,
        run: () => setTheme(next),
      },
      {
        id: 'reconnect-gateway',
        group: 'Gateway',
        title: 'Reconnect to gateway',
        keywords: ['force', 'retry', 'refresh', 'connection', 'server', 'offline', 'stuck'],
        icon: <RefreshCw size={15} />,
        run: () => {
          reconnect?.();
          reconnectGateway();
        },
      },
      {
        id: 'reload',
        group: 'App',
        title: 'Reload app',
        keywords: ['refresh', 'restart', 'reload'],
        icon: <RotateCcw size={15} />,
        run: reloadApp,
      },
    ];
  }, [theme, setTheme, openSettings, reconnect]);
  useCommands('app', commands);
}
