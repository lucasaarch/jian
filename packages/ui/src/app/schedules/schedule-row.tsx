'use client';

import { useState } from 'react';
import { ranOnce } from '../../components/schedules/list';
import { Action, SettingsRow, StatusPill, SwitchControl } from '../../kit';
import type { Schedule } from '../../lib/api';
import { describeCron, inZone } from '../../lib/time';

/**
 * How a schedule stands, in pills: when it runs, then whether it is paused or already ran, and
 * whether its last time failed. `enabled` is what the switch shows, which may be ahead of the
 * gateway.
 */
export function SchedulePills({ item, enabled }: { item: Schedule; enabled: boolean }) {
  const ran = ranOnce(item);

  return (
    <>
      <StatusPill>
        {item.cron ? describeCron(item.cron) : item.at ? inZone(item.at, item.timeZone) : 'Once'}
      </StatusPill>
      {ran && <StatusPill tone="good">Ran</StatusPill>}
      {!ran && !enabled && <StatusPill>Paused</StatusPill>}
      {item.lastError && <StatusPill tone="bad">Failed</StatusPill>}
    </>
  );
}

/**
 * One schedule, a line: its name, how it stands, its switch and the way into everything else.
 * The switch moves the moment it is pressed, while the gateway is told; refused, it goes back to
 * what the gateway holds. A single time that already ran has no switch: it will not run again.
 */
export function ScheduleRow({
  item,
  onSwitch,
  onConfigure,
}: {
  item: Schedule;
  /** False when the gateway refused. */
  onSwitch: (enabled: boolean) => Promise<boolean>;
  onConfigure: () => void;
}) {
  // What was pressed and not yet answered, over what the gateway last said.
  const [pressed, setPressed] = useState<boolean>();
  const enabled = pressed ?? item.enabled;

  const flip = async (on: boolean) => {
    setPressed(on);
    await onSwitch(on);
    // Answered either way: what the gateway holds now is shown, the new value or the old one.
    setPressed(undefined);
  };

  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{item.name}</span>
          <SchedulePills item={item} enabled={enabled} />
        </span>
      }
    >
      {!ranOnce(item) && (
        <SwitchControl
          checked={enabled}
          onCheckedChange={(on) => void flip(on)}
          label={item.name}
        />
      )}
      <Action
        tone="outline"
        size="small"
        aria-label={`Configure ${item.name}`}
        onClick={onConfigure}
      >
        Configure
      </Action>
    </SettingsRow>
  );
}
