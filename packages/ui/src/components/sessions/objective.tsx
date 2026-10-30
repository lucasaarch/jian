'use client';

import { Popover } from '@base-ui/react/popover';
import type { Session } from '../../lib/api';

const tone = {
  open: 'good',
  blocked: 'warn',
  done: 'neutral',
  cancelled: 'neutral',
} as const;

const label = {
  open: 'Objective open',
  blocked: 'Objective blocked',
  done: 'Objective done',
  cancelled: 'Objective cancelled',
} as const;

/**
 * The conversation's objective as a badge saying where it stands, beside where the chat runs.
 * The goal itself, and why it is blocked, open from it: they are often longer than a line.
 */
export function SessionObjective({
  objective,
  side = 'top',
}: {
  objective: NonNullable<Session['objective']>;
  /** Above the composer at the bottom of the screen; below a header at the top. */
  side?: 'top' | 'bottom';
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        className={`badge ${tone[objective.status]} session-badge-trigger`}
        aria-label={`${label[objective.status]}: show the objective`}
      >
        <span className="badge-dot" />
        {label[objective.status]}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="select-positioner"
          side={side}
          align="end"
          sideOffset={8}
          positionMethod="fixed"
          collisionBoundary={[]}
        >
          <Popover.Popup className="model-menu session-badge-popup">
            <Popover.Title className="session-badge-title">{label[objective.status]}</Popover.Title>
            <p>{objective.text}</p>
            {objective.status === 'blocked' && objective.note && (
              <p className="session-objective-note">{objective.note}</p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
