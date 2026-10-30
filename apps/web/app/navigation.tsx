'use client';

import { type LinkProps, type Navigation, NavigationProvider } from '@jian/ui';
import NextLink from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ComponentType, type ReactNode, useMemo } from 'react';

/** The panel's screens move through Next's router here: its links prefetch, its history is the browser's. */
export function NextNavigation({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const navigation = useMemo<Navigation>(
    () => ({
      pathname,
      push: router.push,
      replace: router.replace,
      back: router.back,
      Link: NextLink as ComponentType<LinkProps>,
    }),
    [pathname, router],
  );

  return <NavigationProvider navigation={navigation}>{children}</NavigationProvider>;
}
