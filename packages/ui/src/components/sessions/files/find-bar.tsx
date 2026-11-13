'use client';

import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { iconButton } from '../../../kit';
import { bareInput } from '../../../kit/text-field';
import { findMatches, hitsByLine, matchLabel, stepMatch } from './find';

const NOTHING = { matches: [], capped: false };

/**
 * What the find bar knows of a file's lines: whether it is open, the words, the matches and the
 * one it is on. Closed, it looks for nothing and marks nothing.
 */
export function useFind(lines: readonly string[]) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  // Asked for again while open (the shortcut pressed twice): the field takes the keyboard back.
  const [asked, setAsked] = useState(0);
  const { matches, capped } = useMemo(
    () => (open ? findMatches(lines, query) : NOTHING),
    [open, lines, query],
  );
  const hits = useMemo(() => hitsByLine(matches), [matches]);
  // The file may be read again with fewer matches than the one the bar was on.
  const index = Math.min(at, Math.max(matches.length - 1, 0));
  const match = matches[index];
  const current = useMemo(() => (match ? { line: match.line, index } : undefined), [match, index]);

  return {
    open,
    query,
    asked,
    hits,
    current,
    label: matchLabel(index, matches.length, capped),
    count: matches.length,
    show: () => {
      setOpen(true);
      setAsked((times) => times + 1);
    },
    close: () => setOpen(false),
    type: (words: string) => {
      setQuery(words);
      setAt(0);
    },
    step: (by: 1 | -1) => setAt(stepMatch(index, matches.length, by)),
  };
}

/**
 * Find in the open file: the words, where the bar is among the matches, and the way to the next
 * and the previous. Enter goes on and Shift+Enter back; Escape is the viewer's, which closes it.
 */
export function FindBar({ find }: { find: ReturnType<typeof useFind> }) {
  const bar = useRef<HTMLElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each time it is asked for, not once.
  useEffect(() => {
    const field = bar.current?.querySelector('input');
    field?.focus({ preventScroll: true });
    field?.select();
  }, [find.asked]);

  return (
    <search
      ref={bar}
      aria-label="Find in file"
      className="glass-strong absolute top-2 right-4 z-10 flex h-9 max-w-[calc(100%-1.5rem)] items-center gap-0.5 rounded-full py-1 pr-1 pl-3 shadow-lg phone:right-2"
    >
      {/* The bar is the field: a box of its own inside it would be a frame in a frame. */}
      <label className="flex h-full w-48 min-w-0 items-center gap-2 text-muted phone:w-32">
        <Search size={14} className="shrink-0" aria-hidden="true" />
        <input
          type="search"
          aria-label="Find"
          placeholder="Find"
          value={find.query}
          onChange={(event) => find.type(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            find.step(event.shiftKey ? -1 : 1);
          }}
          className={`${bareInput} text-[13px]`}
        />
      </label>
      <span
        role="status"
        className="min-w-16 shrink-0 px-1 text-center text-xs tabular-nums text-muted"
      >
        {find.query ? find.label : ''}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        className={iconButton}
        disabled={!find.count}
        onClick={() => find.step(-1)}
      >
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Next match"
        className={iconButton}
        disabled={!find.count}
        onClick={() => find.step(1)}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="Close find" className={iconButton} onClick={find.close}>
        <X size={14} aria-hidden="true" />
      </button>
    </search>
  );
}
