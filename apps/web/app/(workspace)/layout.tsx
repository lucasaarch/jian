import { WebApp } from '@jian/ui';
import type { ReactNode } from 'react';

/**
 * Every address below is the one panel, drawn here once so moving between them changes only
 * what it reads from the address. The pages are empty: they exist so each address is known.
 */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <WebApp />
      {children}
    </>
  );
}
