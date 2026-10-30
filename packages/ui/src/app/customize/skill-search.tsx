'use client';

import { Search } from 'lucide-react';
import { bareInput } from '../../kit/text-field';

/**
 * A search small enough for a settings card's title line, for a list long enough to look
 * through: the built-in skills, and the agent's memories.
 */
export function ListSearch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex h-7 w-44 items-center gap-1.5 rounded-md border border-glass-edge bg-glass-hover px-2 text-muted focus-within:border-ink/20">
      <Search size={13} className="shrink-0" aria-hidden="true" />
      <input
        type="search"
        aria-label={label}
        placeholder="Search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${bareInput} text-xs`}
      />
    </label>
  );
}
