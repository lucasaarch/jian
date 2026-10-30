'use client';

import { MonitorDot, SquareTerminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Pulse } from './agents-working';
import { statusItem } from './status-item';

/** An agent using this computer right now: the gateway it answers to, by name, and how. */
export type ComputerUse = { gateway: string; kind: 'shell' | 'computer' };

/** How long the word stays after the use ends, in ms: commands in a row read as one stretch. */
const LINGER = 1_500;

/**
 * That an agent is using this computer, the way the system shows a camera in use: the screen
 * being driven above all, a command otherwise, with the gateway it came from in the tooltip.
 * It opens where the sharing is decided. Shown only while it lasts, and a moment after.
 */
export function ComputerInUse({ uses, open }: { uses: ComputerUse[]; open: () => void }) {
  const [shown, setShown] = useState(uses);
  useEffect(() => {
    if (uses.length) return setShown(uses);
    const timer = setTimeout(() => setShown([]), LINGER);
    return () => clearTimeout(timer);
  }, [uses]);
  if (!shown.length) return null;

  const screen = shown.some((use) => use.kind === 'computer');
  const said = screen ? 'Agent using the screen' : 'Agent running a command';
  const from = [...new Set(shown.map((use) => use.gateway))].join(', ');
  const Icon = screen ? MonitorDot : SquareTerminal;

  return (
    <button
      type="button"
      className={statusItem.replace('text-muted', 'text-ink')}
      onClick={open}
      title={`${said} on this computer, from ${from}`}
    >
      <Pulse tone={screen ? 'bad' : 'live'} />
      <Icon size={13} aria-hidden="true" />
      <span className="truncate">{said}</span>
    </button>
  );
}
