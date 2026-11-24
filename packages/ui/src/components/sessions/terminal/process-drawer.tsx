'use client';

import { useQuery } from '@tanstack/react-query';
import { Square } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { Action } from '../../../kit';
import type { AgentProcess, GatewayApi } from '../../../lib/api';
import { keys } from '../../../lib/query/keys';
import { useCrew } from '../../../lib/stores/crew';
import { InspectorContent, useInspectorHosted } from '../inspector-host';
import type { TerminalApi } from './link';
import { terminalScreen } from './screen';

export type ProcessApi = TerminalApi & Pick<GatewayApi, 'sessionProcesses' | 'stopSessionProcess'>;

/** Where it stands, in a few words. No record is a process the gateway no longer has. */
function processStatus(process: AgentProcess | undefined): string {
  if (!process) return 'Ended: the gateway restarted';
  if (process.status === 'running') return 'Running';
  if (process.status === 'stopped') return 'Stopped';
  return `Exited ${process.exitCode ?? 0}`;
}

/** Stops a command, and says so when the gateway could not. */
export async function stopProcess(
  api: Pick<GatewayApi, 'stopSessionProcess'>,
  profileId: string,
  process: Pick<AgentProcess, 'id' | 'sessionId'>,
) {
  try {
    await api.stopSessionProcess(profileId, process.sessionId, process.id);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'The process could not be stopped.');
  }
}

function ProcessView({
  api,
  profileId,
  processId,
  title,
}: {
  api: ProcessApi;
  profileId: string;
  processId: string;
  title: string;
}) {
  const mount = useRef<HTMLDivElement>(null);
  // Read only: what the agent's command prints, with long lines wrapped to the panel.
  const [screen] = useState(() => terminalScreen(api, profileId, processId, true));
  const link = useSyncExternalStore(screen.link.subscribe, screen.link.state, screen.link.state);
  const sessionId = useCrew((state) => state.sessionId);
  const [stopping, setStopping] = useState(false);
  const { data: processes } = useQuery({
    queryKey: keys.sessionProcesses(profileId, sessionId),
    queryFn: () => api.sessionProcesses(profileId, sessionId as string),
    enabled: Boolean(sessionId),
  });
  const process = processes?.find((item) => item.id === processId);
  // Until the list arrives, only a stream that says it is gone is told to be over.
  const known = processes !== undefined || link.status === 'gone';
  const status = known ? processStatus(process) : 'Running';
  const running = process?.status === 'running';

  useEffect(() => (mount.current ? screen.show(mount.current) : undefined), [screen]);

  return (
    <section data-terminal aria-label="Process" className="terminal flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-10 shrink-0 items-center gap-3 border-b border-glass-edge py-1.5 pr-(--inspector-inset) pl-3 text-xs">
        <code
          className="min-w-0 flex-1 truncate font-mono text-ink"
          title={process?.command ?? title}
        >
          {process?.command ?? title}
        </code>
        <span role="status" className="shrink-0 text-muted">
          {status}
        </span>
        {running && process && (
          <Action
            size="small"
            tone="danger"
            busy={stopping}
            onClick={async () => {
              setStopping(true);
              await stopProcess(api, profileId, process);
              setStopping(false);
            }}
          >
            <Square size={11} aria-hidden="true" fill="currentColor" />
            Stop
          </Action>
        )}
      </header>
      <div ref={mount} className="relative min-h-0 flex-1" />
    </section>
  );
}

/**
 * A command the agent runs in the background, in the Inspector: what it prints, read only, with
 * its state and the way to stop it. An ended one keeps its tab, with how it ended.
 */
export function ProcessDrawer({ api, profileId }: { api: ProcessApi; profileId: string }) {
  const tab = useCrew((state) => state.tabs.find((item) => item.key === state.following));
  const hosted = useInspectorHosted();

  if (!hosted || tab?.kind !== 'process') return null;

  return (
    <InspectorContent>
      <ProcessView
        key={tab.processId}
        api={api}
        profileId={profileId}
        processId={tab.processId}
        title={tab.title}
      />
    </InspectorContent>
  );
}
