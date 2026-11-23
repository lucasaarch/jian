import type { QueryClient, QueryKey } from '@tanstack/react-query';

type Flight = { again: boolean };

/** The refresh under way for each key, per client: a window can hold one client per gateway. */
const flights = new WeakMap<QueryClient, Map<string, Flight>>();

/**
 * Reads a key again because something changed, with at most one read of it on the way.
 *
 * A plain invalidation cancels the read under way and starts another, but no read here passes on
 * React Query's abort signal, so the cancelled request keeps running on the gateway: the slower
 * the gateway, the more of them pile up. Joining the read under way is not enough either, since
 * it may have begun before the change and would clear the stale mark with the old answer. So a
 * read that was joined is followed by one more, and whatever asks meanwhile shares that one.
 */
export async function refresh(
  client: QueryClient,
  queryKey: QueryKey,
  { exact = false }: { exact?: boolean } = {},
): Promise<void> {
  const filters = { queryKey, ...(exact ? { exact } : {}) };
  const id = JSON.stringify([queryKey, exact]);
  const running = flights.get(client) ?? new Map<string, Flight>();
  flights.set(client, running);

  const flying = running.get(id);
  if (flying) {
    flying.again = true;
    return;
  }

  const flight: Flight = { again: false };
  running.set(id, flight);
  try {
    do {
      flight.again = false;
      // Only a read with someone waiting on it can be joined; one left by a closed screen is not.
      const joined = client.isFetching({ ...filters, type: 'active' }) > 0;
      await client.invalidateQueries(filters, { cancelRefetch: false });
      if (joined) await client.invalidateQueries(filters, { cancelRefetch: false });
    } while (flight.again);
  } finally {
    running.delete(id);
  }
}
