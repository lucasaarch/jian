'use client';

import { Switch } from '@base-ui/react/switch';
import { useId } from 'react';
import { SettingsRow } from './settings-layout';

/** The kit's on and off, small enough for the end of a row or a menu's line. */
export function SwitchControl({
  checked,
  onCheckedChange,
  labelledBy,
  describedBy,
  label,
  disabled = false,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Named by words beside it, or by `label` when nothing on screen says it. */
  labelledBy?: string;
  describedBy?: string;
  label?: string;
}) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-label={label}
      // 32 by 20, with 2 of room all round: the 16 thumb travels the 12 left between its stops.
      // In the ink and the page, as everything of the kit's: no colour of its own. It eases in and
      // out, slow enough to be seen crossing. Tailwind moves it with `translate`, not `transform`,
      // so that is the property the thumb's transition names.
      className="inline-flex h-5 w-8 shrink-0 cursor-pointer items-center rounded-full bg-ink/20 p-0.5 transition-colors duration-[350ms] ease-[cubic-bezier(0.65,0,0.35,1)] data-checked:bg-ink data-disabled:cursor-default data-disabled:opacity-50"
    >
      <Switch.Thumb className="block size-4 rounded-full bg-ink shadow-sm transition-[translate,background-color] duration-[350ms] ease-[cubic-bezier(0.65,0,0.35,1)] data-checked:translate-x-3 data-checked:bg-canvas" />
    </Switch.Root>
  );
}

/** A setting turned on and off: a row of a settings card, named by its own words. */
export function Toggle({
  label,
  detail,
  checked,
  onCheckedChange,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <SettingsRow
      title={label}
      description={detail}
      labelId={`${id}-label`}
      descriptionId={`${id}-detail`}
    >
      <SwitchControl
        checked={checked}
        onCheckedChange={onCheckedChange}
        labelledBy={`${id}-label`}
        {...(detail ? { describedBy: `${id}-detail` } : {})}
      />
    </SettingsRow>
  );
}
