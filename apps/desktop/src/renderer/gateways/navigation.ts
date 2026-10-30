import { createMemoryNavigation, newChatPath } from '@jian/ui';

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

/**
 * A new chat with the agent the gateway's panel shows. A panel not shown since the app started
 * names no agent yet: it opens where it would, on the last agent's chats, with none started.
 */
export function openNewChat(gatewayId: string): void {
  const agent = /^\/agents\/([^/?#]+)/.exec(navigationFor(gatewayId).current())?.[1];
  if (agent) openIn(gatewayId, newChatPath(decodeURIComponent(agent)));
}

export function forget(gatewayId: string): void {
  places.delete(gatewayId);
}
