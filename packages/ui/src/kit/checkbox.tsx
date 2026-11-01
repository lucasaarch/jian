'use client';

import { Checkbox } from '@base-ui/react/checkbox';
import { Check } from 'lucide-react';

/** The kit's tick, for marking one thing in a list as done. */
export function CheckBox({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** What it marks, since nothing on screen says it. */
  label: string;
}) {
  return (
    <Checkbox.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      title={label}
      className="grid size-4 shrink-0 place-items-center rounded-[5px] border border-glass-edge bg-glass-hover text-on-accent outline-none transition-colors hover:bg-glass-press focus-visible:ring-2 focus-visible:ring-ink data-checked:border-accent data-checked:bg-accent"
    >
      <Checkbox.Indicator className="grid place-items-center">
        <Check size={11} strokeWidth={3} aria-hidden="true" />
      </Checkbox.Indicator>
    </Checkbox.Root>
  );
}
