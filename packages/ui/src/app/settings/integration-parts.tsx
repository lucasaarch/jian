'use client';

import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * A page of someone else's, at the end of a row: a plain link to a new tab, so the web opens a
 * tab and the desktop app hands it to the system's browser. Drawn as the kit's small quiet action.
 */
export function ExternalAction({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap text-muted transition-colors hover:bg-glass-hover hover:text-ink"
    >
      {children}
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}
