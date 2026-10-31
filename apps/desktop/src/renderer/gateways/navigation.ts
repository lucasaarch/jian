import { createMemoryNavigation, newChatPath } from '@jian/ui';

type MemoryNavigation = ReturnType<typeof createMemoryNavigation>;

/**
 * Each gateway's panel keeps its own place: switching to another gateway and back returns to the
 * conversation that was open, including after a reload or a later launch.
 */
const places = new Map<string, MemoryNavigation>();

export function navigationFor(gatewayId: string): MemoryNavigation {
  let navigation = places.get(gatewayId);
  if (!navigation) {
    const key = `jian.desktop.place.${gatewayId}`;
    let initial = '/';
    try {
      const saved = localStorage.getItem(key);
      if (saved?.startsWith('/') && !saved.startsWith('//') && saved !== '/sign-in') {
        initial = saved;
      }
    } catch {
      // Navigation still works when browser storage is unavailable.
    }
    const memory = createMemoryNavigation(initial);
    memory.subscribe(() => {
      const href = memory.current();
      // An unreachable gateway's temporary sign-in screen must not replace the owner's place.
      if (href.split('?')[0] === '/sign-in') return;
      try {
        localStorage.setItem(key, href);
      } catch {
        // Only the next reload forgets this move.
      }
    });
    navigation = memory;
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

/** The agent an address belongs to, with or without a chat open in it. */
export function profileAt(href: string): string | undefined {
  const match = /^\/agents\/([^/?#]+)/.exec(href);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

export function forget(gatewayId: string): void {
  places.delete(gatewayId);
  try {
    localStorage.removeItem(`jian.desktop.place.${gatewayId}`);
  } catch {
    // Removing a gateway must work even when browser storage is unavailable.
  }
}
