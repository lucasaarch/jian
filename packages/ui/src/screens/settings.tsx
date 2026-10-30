'use client';

import { type ReactNode, Suspense } from 'react';
import { Loading } from '../components/shell/states';

/**
 * The gateway's own screens: shared by every agent, so they read no agent from the address and
 * work before the first one exists.
 */
export function SettingsArea({ children }: { children: ReactNode }) {
  return (
    <div className="page-enter">
      <Suspense fallback={<Loading />}>{children}</Suspense>
    </div>
  );
}
