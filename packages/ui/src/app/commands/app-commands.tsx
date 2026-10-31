'use client';

import {
  Cable,
  Cpu,
  Keyboard,
  KeyRound,
  Monitor,
  MoonStar,
  Palette,
  PanelLeft,
  Plug,
  RotateCcw,
  Settings2,
  Sun,
} from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { useThemeChoice } from '../../components/shell/theme';
import { reloadApp } from '../reload';
import { toggleSidebar } from '../sidebar-bar';
import { type AppCommand, useCommands } from './registry';

/** The settings pages a command opens straight to; a gateway without one shows General. */
const pages: { id: string; title: string; keywords: string[]; icon: ReactNode }[] = [
  {
    id: 'keymaps',
    title: 'Keymaps',
    keywords: ['keyboard', 'shortcut', 'binding'],
    icon: <Keyboard size={15} />,
  },
  {
    id: 'appearance',
    title: 'Appearance',
    keywords: ['theme', 'font', 'motion'],
    icon: <Palette size={15} />,
  },
  {
    id: 'providers',
    title: 'Providers',
    keywords: ['models', 'api key', 'anthropic', 'openai', 'connect'],
    icon: <Plug size={15} />,
  },
  {
    id: 'models',
    title: 'Model defaults',
    keywords: ['model', 'effort', 'default'],
    icon: <Cpu size={15} />,
  },
  {
    id: 'integrations',
    title: 'Integrations',
    keywords: ['github', 'mcp', 'web search', 'connect'],
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
 * sidebar, the theme. `openSettings` opens the overlay, on `page` when one is named.
 */
export function useAppCommands(openSettings: (page?: string) => void): void {
  const { theme, setTheme } = useThemeChoice();
  const commands = useMemo<AppCommand[]>(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    return [
      {
        id: 'settings',
        title: 'Open settings',
        keywords: ['preferences', 'options'],
        icon: <Settings2 size={15} />,
        keys: { key: ',' },
        run: () => openSettings(),
      },
      ...pages.map<AppCommand>((page) => ({
        id: `settings-${page.id}`,
        title: page.title,
        detail: 'Settings',
        keywords: ['settings', ...page.keywords],
        icon: page.icon,
        ...(page.id === 'keymaps' ? { keys: { key: ',', shift: true } } : {}),
        run: () => openSettings(page.id),
      })),
      {
        id: 'sidebar',
        title: 'Toggle sidebar',
        keywords: ['chats', 'list', 'hide', 'show', 'collapse'],
        icon: <PanelLeft size={15} />,
        keys: { key: 'b' },
        run: toggleSidebar,
      },
      {
        id: 'theme',
        keys: { key: 'l', shift: true },
        title: next === 'light' ? 'Switch to light theme' : 'Switch to dark theme',
        keywords: ['appearance', 'theme', 'dark', 'light', 'mode'],
        icon: next === 'light' ? <Sun size={15} /> : <MoonStar size={15} />,
        run: () => setTheme(next),
      },
      {
        id: 'reload',
        title: 'Reload app',
        keywords: ['refresh', 'restart', 'reload'],
        icon: <RotateCcw size={15} />,
        run: reloadApp,
      },
    ];
  }, [theme, setTheme, openSettings]);
  useCommands('app', commands);
}
