'use client';

import { Switch } from '@base-ui/react/switch';
import { useId } from 'react';

/** An on and off of the kit, named by the words beside it. */
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
    <div className="flex items-center justify-between gap-6 py-1">
      <span className="grid gap-0.5">
        <span id={`${id}-label`} className="text-sm text-ink">
          {label}
        </span>
        {detail && (
          <span id={`${id}-detail`} className="text-xs text-muted">
            {detail}
          </span>
        )}
      </span>
      <Switch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={detail ? `${id}-detail` : undefined}
        className="relative h-6 w-10 shrink-0 rounded-full border border-glass-edge bg-glass-press transition-colors data-checked:bg-accent"
      >
        <Switch.Thumb className="block size-5 translate-x-px rounded-full bg-ink shadow-sm transition-[translate,background-color] data-checked:translate-x-[17px] data-checked:bg-on-accent" />
      </Switch.Root>
    </div>
  );
}
