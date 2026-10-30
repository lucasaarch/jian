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

/** The conversation an address opens, as the panel writes it: `/agents/:agent/sessions/:chat`. */
export function chatAt(href: string): { profileId: string; sessionId: string } | undefined {
  const match = /^\/agents\/([^/?#]+)\/sessions\/([^/?#]+)/.exec(href);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    return { profileId: decodeURIComponent(match[1]), sessionId: decodeURIComponent(match[2]) };
  } catch {
    return undefined;
  }
}

export function forget(gatewayId: string): void {
  places.delete(gatewayId);
}
