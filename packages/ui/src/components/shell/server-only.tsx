'use client';

import type { ReactNode } from 'react';
import { useGatewayMode } from '../../lib/gateway-mode';
import { Empty } from '../ui';

/**
 * A section only a server's gateway has, reached on a desktop app's own one — by a link or an
 * address, since the navigation leaves it out: it says why, instead of failing on its first call.
 */
export function ServerOnly({
  title,
  why,
  children,
}: {
  title: string;
  why: string;
  children: ReactNode;
}) {
  const mode = useGatewayMode();
  if (mode === undefined) return null;
  if (mode === 'local') return <Empty title={title}>{why}</Empty>;
  return children;
}
