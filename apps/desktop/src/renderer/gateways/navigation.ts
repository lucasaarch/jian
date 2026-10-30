import { createMemoryNavigation } from '@jian/ui';

type MemoryNavigation = ReturnType<typeof createMemoryNavigation>;

/**
 * Each gateway's panel keeps its own place: switching to another gateway and back returns to the
 * conversation that was open. Kept for as long as the app runs.
 */
const places = new Map<string, MemoryNavigation>();

export function navigationFor(gatewayId: string): MemoryNavigation {
  let navigation = places.get(gatewayId);
  if (!navigation) {
    navigation = createMemoryNavigation('/');
    places.set(gatewayId, navigation);
  }
  return navigation;
}

/** Where a notification leads: the gateway's panel moves there, its back button returning here. */
export function openIn(gatewayId: string, path: string): void {
  const navigation = navigationFor(gatewayId);
  navigation.navigation(navigation.current()).push(path);
}

export function forget(gatewayId: string): void {
  places.delete(gatewayId);
}
