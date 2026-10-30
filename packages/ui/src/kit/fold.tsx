'use client';

import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

/** The Thought Line's settle: the same time and curve, so every fold moves alike. */
const ease = 'ease-[cubic-bezier(0.23,1,0.32,1)]';

/**
 * What opens and folds beneath a heading, its height eased from nothing to its own. It stays
 * mounted so the motion has something to move; folded, it cannot be reached.
 */
export function Fold({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  return (
    <div
      id={id}
      inert={!open}
      className={`grid transition-[grid-template-rows] duration-350 ${ease} ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** Points down while what it heads is open, and to the side once it is folded. */
export function FoldChevron({ open, className = '' }: { open: boolean; className?: string }) {
  return (
    <ChevronDown
      size={13}
      aria-hidden="true"
      className={`shrink-0 transition-transform duration-200 ${ease} ${open ? '' : '-rotate-90'} ${className}`}
    />
  );
}
