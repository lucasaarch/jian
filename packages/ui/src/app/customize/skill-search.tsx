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

/**
 * The search's place while there is no list to search, the size of the field. A card's title
 * line aligns on the field's baseline, which is its icon's lower edge, as the icon comes first and
 * has no text: an empty block of the same size and place keeps that edge where it will be.
 */
export function ListSearchWaiting() {
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-44 items-center rounded-md border border-transparent bg-ink/8 px-2 motion-safe:animate-pulse"
    >
      <span className="size-[13px] shrink-0" />
    </span>
  );
}
