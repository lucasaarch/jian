import { toast, useThemeChoice } from '@jian/ui';
import { MoonStar, RefreshCw, Settings2, Sun } from 'lucide-react';
import { createElement, useMemo } from 'react';
import { desktop } from '../desktop';
import { type AppCommand, useCommands } from './registry';

/** What an update check found, said where the owner is looking. */
async function checkForUpdates() {
  const pending = toast.loading('Checking for updates…');
  const found = await desktop().checkForUpdates();
  toast.dismiss(pending);
  if (found.state === 'unavailable')
    toast.info('Updates come with the installed app; this one runs from source.');
  else if (found.state === 'latest') toast.success(`Jian ${found.version} is the latest release.`);
  else if (found.state === 'available')
    toast.success(`Jian ${found.version} is downloading; it installs when you quit.`);
  else toast.error(`Could not check for updates: ${found.reason}`);
}

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
        run: () => void checkForUpdates(),
      },
    ];
  }, [theme, setTheme, openSettings]);
  useCommands('window', commands);
}
