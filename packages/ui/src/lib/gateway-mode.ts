'use client';

import { useQuery } from '@tanstack/react-query';
import type { NavigationItem } from './navigation';
import { queries } from './query/profile';

/**
 * Whether the panel is on a server or on the gateway a desktop app runs. Undefined until the
 * gateway says, and until then nothing only a server has is shown: a section that appears and
 * then goes would flicker on every app launch.
 */
export function useGatewayMode(): 'server' | 'local' | undefined {
  const { data } = useQuery(queries.gateway());
  return data ? (data.mode ?? 'server') : undefined;
}

/** The sections this gateway has. */
export function useAvailable(): (item: NavigationItem) => boolean {
  const mode = useGatewayMode();
  return (item) => !item.serverOnly || mode === 'server';
}
