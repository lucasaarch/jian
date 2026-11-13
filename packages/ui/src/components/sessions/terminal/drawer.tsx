'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Action } from '../../../kit';
import { useCrew } from '../../../lib/stores/crew';
import { InspectorContent, useInspectorHosted } from '../inspector-host';
import type { TerminalApi, TerminalState } from './link';
import { terminalScreen } from './screen';
import { openTerminalTab, terminalsHere } from './tabs';

/** What is said under a terminal that is not simply running, and the way on from there. */
function notice(state: TerminalState): { text: string; action?: string } | undefined {
  if (state.status === 'exited') {
    return { text: `The shell exited with code ${state.exitCode}.`, action: 'Restart' };
  }
  if (state.status === 'gone') {
    return {
      text: 'This terminal has ended: it was closed, or the gateway restarted.',
      action: 'New terminal',
    };
  }
  if (state.status === 'away') return { text: 'Connection lost. Reconnecting…' };

  return undefined;
}

function TerminalView({
  api,
  profileId,
  terminalId,
  tabKey,
}: {
  api: TerminalApi;
  profileId: string;
  terminalId: string;
  tabKey: string;
}) {
  const mount = useRef<HTMLDivElement>(null);
  // The registry's own, the same one this tab had before the Inspector turned to another.
  const [screen] = useState(() => terminalScreen(api, profileId, terminalId));
  const state = useSyncExternalStore(screen.link.subscribe, screen.link.state, screen.link.state);
  const [starting, setStarting] = useState(false);
  const said = notice(state);

  useEffect(() => (mount.current ? screen.show(mount.current) : undefined), [screen]);

  return (
    // The Inspector's Escape is left to the shell while a key is pressed in here.
    <section data-terminal aria-label="Terminal" className="terminal flex min-h-0 flex-1 flex-col">
      <div ref={mount} className="relative min-h-0 flex-1" />
      {said && (
        <div
          role="status"
          className="flex min-h-10 shrink-0 items-center gap-3 border-t border-glass-edge py-1.5 pr-(--inspector-inset) pl-3 text-xs text-muted"
        >
          <span className="min-w-0 flex-1">{said.text}</span>
          {said.action && (
            <Action
              size="small"
              tone="outline"
              busy={starting}
              onClick={async () => {
                setStarting(true);
                // The tab becomes the new terminal's, and this view goes with the old one.
                await openTerminalTab(tabKey);
                setStarting(false);
              }}
            >
              {said.action}
            </Action>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * A shell on the gateway's machine, in the Inspector's terminal tabs. Drawn with the
 * conversation, which is what knows the agent and its gateway: it also tells the Inspector's
 * frame where a new terminal opens.
 */
export function TerminalDrawer({ api, profileId }: { api: TerminalApi; profileId: string }) {
  const tab = useCrew((state) => state.tabs.find((item) => item.key === state.following));
  const hosted = useInspectorHosted();

  useEffect(() => terminalsHere({ api, profileId }), [api, profileId]);

  // Only in the Inspector: a conversation drawn without one has nowhere to put a terminal.
  if (!hosted || tab?.kind !== 'terminal') return null;

  return (
    <InspectorContent>
      <TerminalView
        key={tab.terminalId}
        api={api}
        profileId={profileId}
        terminalId={tab.terminalId}
        tabKey={tab.key}
      />
    </InspectorContent>
  );
}
