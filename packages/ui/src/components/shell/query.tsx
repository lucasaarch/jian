'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { type ReactNode, useState } from 'react';
import { createQueryClient } from '../../lib/query/client';
import { gatewayPersister } from '../../lib/query/persist';

/**
 * One cache per browser tab; a server render gets its own and never shares it. Given `keep`, the
 * cache is also kept on this computer under that key, so what was read once shows at once on
 * the next start, and while the gateway cannot be reached. `release` drops what an older
 * release kept, whose shapes this one may not read.
 */
export function QueryProvider({
  children,
  keep,
}: {
  children: ReactNode;
  keep?: { key: string; release: string };
}) {
  const [client] = useState(() => createQueryClient({ kept: Boolean(keep) }));
  const [persister] = useState(() => (keep ? gatewayPersister(keep.key) : undefined));

  if (!keep || !persister) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{ persister, buster: keep.release, maxAge: Number.POSITIVE_INFINITY }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
