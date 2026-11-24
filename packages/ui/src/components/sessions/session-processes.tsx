'use client';

import { Popover } from '@base-ui/react/popover';
import { useQuery } from '@tanstack/react-query';
import { Square, SquareTerminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { HoverTip, iconButton, pillClass } from '../../kit';
import type { AgentProcess, GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { useCrew } from '../../lib/stores/crew';
import { stopProcess } from './terminal/process-drawer';

type ProcessesApi = Pick<GatewayApi, 'sessionProcesses' | 'stopSessionProcess'>;

/** Minutes and seconds since it started, then hours and minutes. */
function since(from: number, to: number) {
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return hours
    ? `${hours}h ${String(minutes).padStart(2, '0')}m`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A clock for the open list: once a second, and only while it is on screen. */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  return now;
}

/** The command's name on a tab: its first characters, since the line itself may run long. */
const titleOf = (command: string) => command.trim().replace(/\s+/g, ' ').slice(0, 40);

function ProcessRow({
  process,
  now,
  onOpen,
  onStop,
}: {
  process: AgentProcess;
  now: number;
  onOpen: () => void;
  onStop: () => void;
}) {
  return (
    <div className="session-process">
      <button type="button" className="session-process-open" onClick={onOpen}>
        <code className="session-process-command" title={process.command}>
          {process.command}
        </code>
        <span className="session-process-time">{since(Date.parse(process.startedAt), now)}</span>
      </button>
      <HoverTip tip="Stop this process">
        <button
          type="button"
          className={iconButton}
          aria-label={`Stop ${titleOf(process.command)}`}
          onClick={onStop}
        >
          <Square size={12} aria-hidden="true" fill="currentColor" className="text-bad" />
        </button>
      </HoverTip>
    </div>
  );
}

/**
 * The commands the agent is running in the background for this conversation, as a badge beside
 * its pull requests: shown only while one runs. Each row opens its output in the Inspector and
 * can stop it. The list is read again when the gateway says one began or ended.
 */
export function SessionProcesses({
  api,
  profileId,
  sessionId,
}: {
  api: ProcessesApi;
  profileId: string;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: all = [] } = useQuery({
    queryKey: keys.sessionProcesses(profileId, sessionId),
    queryFn: () => api.sessionProcesses(profileId, sessionId),
  });
  const running = all.filter((process) => process.status === 'running');
  const now = useNow(open && running.length > 0);

  if (!running.length) return null;

  const label = running.length === 1 ? '1 process' : `${running.length} processes`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={`${pillClass()} session-badge-trigger`}
        aria-label={`${label}: show the commands the agent is running`}
      >
        <SquareTerminal size={12} aria-hidden="true" />
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="select-positioner"
          side="top"
          align="end"
          sideOffset={8}
          positionMethod="fixed"
          collisionBoundary={[]}
        >
          <Popover.Popup className="model-menu session-badge-popup session-processes-popup">
            <Popover.Title className="session-badge-title">Running in the background</Popover.Title>
            <ul className="session-processes" aria-label="Running processes">
              {running.map((process) => (
                <li key={process.id}>
                  <ProcessRow
                    process={process}
                    now={now}
                    onOpen={() => {
                      setOpen(false);
                      useCrew.getState().openProcess(process.id, titleOf(process.command));
                    }}
                    onStop={() => void stopProcess(api, profileId, process)}
                  />
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
