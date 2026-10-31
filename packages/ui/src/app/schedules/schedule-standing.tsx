'use client';

import { useId, useState } from 'react';
import { ranOnce } from '../../components/schedules/list';
import { SettingsRow, StatusPill, SwitchControl } from '../../kit';
import type { Schedule } from '../../lib/api';
import { describeCron, inZone } from '../../lib/time';

/**
 * How a schedule stands, in pills: when it runs, then whether it is paused or already ran, and
 * whether its last time failed.
 */
export function SchedulePills({ item }: { item: Schedule }) {
  const ran = ranOnce(item);

  return (
    <>
      <StatusPill>
        {item.cron ? describeCron(item.cron) : item.at ? inZone(item.at, item.timeZone) : 'No time'}
      </StatusPill>
      {ran && <StatusPill tone="good">Ran</StatusPill>}
      {!ran && !item.enabled && <StatusPill>Paused</StatusPill>}
      {item.lastError && <StatusPill tone="bad">Failed</StatusPill>}
    </>
  );
}

/**
 * Whether it runs. The switch moves the moment it is pressed, while the gateway is told; refused,
 * it goes back to what the gateway holds. A single time that already ran has none: it will not
 * run again.
 */
export function ScheduleSwitch({
  item,
  onSwitch,
}: {
  item: Schedule;
  /** False when the gateway refused. */
  onSwitch: (enabled: boolean) => Promise<boolean>;
}) {
  // What was pressed and not yet answered, over what the gateway last said.
  const [pressed, setPressed] = useState<boolean>();
  const enabled = pressed ?? item.enabled;
  const label = useId();

  const flip = async (on: boolean) => {
    setPressed(on);
    await onSwitch(on);
    // Answered either way: what the gateway holds now is shown, the new value or the old one.
    setPressed(undefined);
  };

  return (
    <SettingsRow
      title={<span id={label}>Active</span>}
      description="Paused, it stays here and does not run."
    >
      <SwitchControl checked={enabled} onCheckedChange={(on) => void flip(on)} labelledBy={label} />
    </SettingsRow>
  );
}
