import { openUpdates, toggleSidebar, useThemeChoice } from '@jian/ui';
import { MoonStar, PanelLeft, RefreshCw, Settings2, Sun } from 'lucide-react';
import { createElement, useMemo } from 'react';
import { type AppCommand, useCommands } from './registry';

/** The commands of the window itself, whatever gateway is open. */
export function useWindowCommands(openSettings: () => void): void {
  const { theme, setTheme } = useThemeChoice();
  const commands = useMemo<AppCommand[]>(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    return [
      {
        id: 'settings',
        title: 'Open settings',
        keywords: ['preferences', 'options'],
        icon: createElement(Settings2, { size: 15 }),
        keys: { key: ',' },
        run: openSettings,
      },
      {
        id: 'sidebar',
        title: 'Toggle sidebar',
        keywords: ['chats', 'list', 'hide', 'show', 'collapse'],
        icon: createElement(PanelLeft, { size: 15 }),
        keys: { key: 'b' },
        run: toggleSidebar,
      },
      {
        id: 'theme',
        title: next === 'light' ? 'Switch to light theme' : 'Switch to dark theme',
        keywords: ['appearance', 'theme', 'dark', 'light', 'mode'],
        icon: createElement(next === 'light' ? Sun : MoonStar, { size: 15 }),
        run: () => setTheme(next, { x: window.innerWidth / 2, y: 0 }),
      },
      {
        id: 'updates',
        title: 'Check for updates',
        keywords: ['update', 'version', 'release', 'upgrade'],
        icon: createElement(RefreshCw, { size: 15 }),
        run: () => openUpdates({ check: true }),
      },
    ];
  }, [theme, setTheme, openSettings]);
  useCommands('window', commands);
}
