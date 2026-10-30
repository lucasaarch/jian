'use client';

import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import type { ReactNode } from 'react';

/** One choice among a few, all in view: a theme, a mode. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T, event: { x: number; y: number }) => void;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      // As wide as its choices, wherever it stands: a row of tabs does not stretch across a page.
      className="inline-flex w-fit gap-0.5 rounded-lg border border-glass-edge bg-glass-hover p-0.5"
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          onClick={(event) => onChange(option.value, { x: event.clientX, y: event.clientY })}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted transition-colors hover:text-ink data-pressed:bg-glass-press data-pressed:text-ink"
        >
          {option.icon}
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
