'use client';

import type { ReactNode } from 'react';
import { Sessions } from '../components/sessions';
import { useActions } from '../lib/workspace';

/**
 * The list and the open conversation are one screen. It lives in the layout so that opening
 * another conversation changes only the URL: the list, its search and its filter stay put.
 */
export function SessionsScreen({ children }: { children: ReactNode }) {
  return (
    <>
      <Sessions {...useActions()} />
      {children}
    </>
  );
}
