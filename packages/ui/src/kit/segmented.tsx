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
      className="inline-flex gap-1 rounded-full border border-glass-edge bg-glass-hover p-1"
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          onClick={(event) => onChange(option.value, { x: event.clientX, y: event.clientY })}
          className="inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-sm text-muted transition-colors hover:text-ink data-pressed:bg-accent data-pressed:text-on-accent"
        >
          {option.icon}
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
