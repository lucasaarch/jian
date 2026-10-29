'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import { create } from 'zustand';
import { revealTheme } from './theme-reveal';

type Theme = 'dark' | 'light';

const SAVED = 'jian-theme';

/**
 * The theme is this browser's choice, kept under `jian-theme` as a bare word. The page renders
 * dark first and takes the saved theme once mounted, so the server and the first client render
 * agree.
 */
const useTheme = create<{
  theme: Theme;
  setTheme: (theme: Theme, origin?: { x: number; y: number }) => void;
}>()((set, get) => ({
  theme: 'dark',
  setTheme: (next, origin = { x: window.innerWidth / 2, y: 0 }) => {
    if (next === get().theme) return;
    try {
      window.localStorage.setItem(SAVED, next);
    } catch {
      // Storage can be off; the theme still changes for this visit.
    }
    revealTheme(origin, () => {
      flushSync(() => set({ theme: next }));
      document.documentElement.dataset.theme = next;
    });
  },
}));

/** Puts the saved theme on the page and keeps the page on the chosen one. Renders nothing. */
export function ThemeSync() {
  const theme = useTheme((state) => state.theme);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SAVED);
      if (saved === 'light' || saved === 'dark') useTheme.setState({ theme: saved });
    } catch {
      // No storage, no saved theme.
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return null;
}

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();

  return (
    <fieldset className="theme-switcher">
      <legend className="sr-only">Theme</legend>
      <button
        type="button"
        className={theme === 'dark' ? 'active' : ''}
        onClick={(event) => setTheme('dark', { x: event.clientX, y: event.clientY })}
        aria-pressed={theme === 'dark'}
      >
        <Moon size={15} /> Dark
      </button>
      <button
        type="button"
        className={theme === 'light' ? 'active' : ''}
        onClick={(event) => setTheme('light', { x: event.clientX, y: event.clientY })}
        aria-pressed={theme === 'light'}
      >
        <Sun size={15} /> Light
      </button>
    </fieldset>
  );
}
