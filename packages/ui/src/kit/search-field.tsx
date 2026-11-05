'use client';

import { Search } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { bareInput } from './text-field';

/**
 * The box a list is searched and filtered in, without its text colour: the search is muted until
 * typed into, a filter beside it shows its choice in ink.
 */
export const searchBox =
  'flex h-8 min-w-0 items-center gap-2 rounded-lg border border-glass-edge bg-glass-hover px-2.5 focus-within:border-ink/20';

/**
 * A search over a list on the same surface: a sidebar's pages, a page's cards. It filters as it
 * is typed into; Enter can open the first thing found.
 */
export function SearchField({
  label,
  value,
  onValueChange,
  onKeyDown,
  className = '',
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
}) {
  return (
    <label className={`${searchBox} text-muted ${className}`}>
      <Search size={14} className="shrink-0" aria-hidden="true" />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        {...(onKeyDown ? { onKeyDown } : {})}
        className={`${bareInput} text-[13px]`}
      />
    </label>
  );
}
