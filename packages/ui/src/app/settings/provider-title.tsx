'use client';

import { Server } from 'lucide-react';
import type { ReactNode } from 'react';
import { hasLogo, ProviderLogo } from '../../components/ui';

/** A provider's row title: its mark, or a server's for one without, beside its name. */
export function ProviderTitle({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      {hasLogo(kind) ? (
        <ProviderLogo kind={kind} size={16} />
      ) : (
        <Server size={15} strokeWidth={1.6} className="text-muted" aria-hidden="true" />
      )}
      {children}
    </span>
  );
}
