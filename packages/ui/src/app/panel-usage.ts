'use client';

import type { PanelFeature } from '@jian/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useThemeChoice } from '../components/shell/theme';
import { panelApi } from '../lib/query/client';
import { keys } from '../lib/query/keys';
import { type InspectorTab, useCrew } from '../lib/stores/crew';
import { countUsage, flushUsage, setUsageReporting } from '../lib/usage';

/** How often what the panel counted is handed to the gateway, in ms. */
const FLUSH_MS = 5 * 60_000;

const INSPECTOR_TABS: Record<InspectorTab['kind'], PanelFeature> = {
  browser: 'inspector_browser',
  files: 'inspector_files',
  changes: 'inspector_changes',
  artifacts: 'inspector_artifacts',
  terminal: 'inspector_terminal',
  github: 'inspector_github',
  agent: 'inspector_subagent',
};

/**
 * The Inspector opened, and a tab turned to, by the owner. Coming back to a conversation brings
 * back its Inspector as it was left, and closing a tab turns to its neighbour: neither counts.
 */
function inspectorUsage(now: ReturnType<typeof useCrew.getState>, was: typeof now) {
  if (now.sessionId !== was.sessionId || now.tabs.length < was.tabs.length) return;
  if (now.opened && !was.opened) countUsage('inspector_opened');
  if (!now.following || now.following === was.following) return;
  const tab = now.tabs.find((item) => item.key === now.following);
  if (tab) countUsage(INSPECTOR_TABS[tab.kind]);
}

/**
 * Hands the panel's counts of its own use (lib/usage.ts) to its gateway while the gateway's
 * anonymous report is on: every few minutes, as the page is hidden, and as it closes. The setting
 * is the one Settings → General shows, read from the same query, so turning it off there stops
 * this at once. Mounted once, by the app's one screen.
 */
export function usePanelUsage() {
  const enabled = useQuery({ queryKey: keys.settings, queryFn: () => panelApi().settings() }).data
    ?.telemetry?.enabled;
  const theme = useThemeChoice().theme;

  useEffect(() => countUsage('panel_opened'), []);
  useEffect(() => useCrew.subscribe(inspectorUsage), []);

  useEffect(() => {
    setUsageReporting(enabled);
    if (!enabled) return;
    const flush = (leaving: boolean) =>
      void flushUsage((usage) => panelApi().reportPanelUsage(usage, leaving));
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush(true);
    };
    const closing = () => flush(true);
    const timer = setInterval(() => flush(false), FLUSH_MS);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', closing);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', closing);
    };
  }, [enabled]);

  // The theme in use, read once the gateway has answered: by then the saved one is applied.
  useEffect(() => {
    if (enabled) countUsage(theme === 'light' ? 'theme_light' : 'theme_dark');
  }, [enabled, theme]);
}
