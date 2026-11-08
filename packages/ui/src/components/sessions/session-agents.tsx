'use client';

import { Popover } from '@base-ui/react/popover';
import { Bot } from 'lucide-react';
import { useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { pillClass } from '../../kit';
import type { Subagent } from '../../lib/api';
import { useCrew } from '../../lib/stores/crew';
import { active, Elapsed, nowOf } from './crew';

/** None at work: one list for every render, so the badge is not drawn again for nothing. */
const NONE: Subagent[] = [];

/**
 * The conversation's subagents at work, as a badge beside its pull requests, with each one in
 * the list it opens: a way to them when their cards are far up the conversation. It reads only
 * what the open History already showed the Inspector, which follows them while they work, and
 * only for this conversation: the store may still hold the one the owner left.
 */
export function SessionAgents({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const working = useCrew(
    useShallow((state) => (state.sessionId === sessionId ? state.agents.filter(active) : NONE)),
  );

  if (!working.length) return null;

  const label = working.length === 1 ? '1 agent working' : `${working.length} agents working`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        ref={trigger}
        className={`${pillClass()} session-badge-trigger`}
        aria-label={`${label}: show the subagents at work`}
      >
        <Bot size={12} aria-hidden="true" />
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
          <Popover.Popup className="model-menu session-badge-popup session-agents-popup">
            <Popover.Title className="session-badge-title">Subagents at work</Popover.Title>
            <ul className="session-agents" aria-label="Subagents at work">
              {working.map((agent) => (
                <li key={agent.runId}>
                  <button
                    type="button"
                    className="session-agent"
                    onClick={() => {
                      setOpen(false);
                      useCrew.getState().follow(agent.runId, trigger.current);
                    }}
                  >
                    <span className="session-agent-text">
                      <span className="session-agent-name">{agent.name}</span>
                      <span className="session-agent-now">{nowOf(agent)}</span>
                    </span>
                    <Elapsed agent={agent} className="session-agent-time" />
                  </button>
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
