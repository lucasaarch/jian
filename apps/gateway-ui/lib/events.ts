import type { GatewayEvent } from './api/events';

type Listener = (event: GatewayEvent) => void;

const listeners = new Set<Listener>();

/**
 * Hears every event of the open profile as it arrives, for a screen that keeps something live
 * of its own, such as an open conversation. Returns the way to stop listening. Nothing is heard
 * while no stream is open — a component rendered alone, as in a story or a test, simply waits.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** Called by the open profile's stream only. */
export function publish(event: GatewayEvent) {
  for (const listener of listeners) listener(event);
}
