import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { retryPace } from '../api/retry-pace';
import { publish } from '../events';
import { useReconnect } from '../stores/reconnect';
import { panelApi } from './client';
import { staleOf, staleReads } from './stale-events';

/**
 * The wait before a dropped stream is opened again, in ms. Short, because a contact request or an
 * answer waits on it; a gateway that refuses the stream is asked less often (`retry-pace.ts`).
 */
const AGAIN = { firstMs: 1_000, mostMs: 5_000 };

/**
 * Follows the open profile's event stream for as long as its pages are open. A contact request
 * must reach the owner without a reload, so a dropped stream is reopened from the last event
 * seen. Events arrive in bursts as a turn moves; each key is read once per burst, or less often
 * while a turn works when the read is costly (`stale-events.ts`).
 */
export function useEventStream(profileId: string) {
  const client = useQueryClient();
  const connection = useReconnect((state) => state.connection);

  // Asked to reconnect: what was missed while the stream was down is read again.
  useEffect(() => {
    if (connection > 0) void client.invalidateQueries();
  }, [connection, client]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new connection the owner asked for opens the stream again.
  useEffect(() => {
    const controller = new AbortController();
    // Unknown until the stream's first event: an opening is from now, not the whole feed.
    let cursor: number | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const pace = retryPace(AGAIN);

    const staleFor = staleOf(profileId);
    const reads = staleReads(client);

    const listen = async () => {
      let failure: unknown;
      reconnect = undefined;
      pace.began();
      try {
        await panelApi().events(
          profileId,
          cursor,
          (event) => {
            cursor = event.id;
            reads.tell(staleFor(event));
            publish(event);
          },
          controller.signal,
        );
      } catch (error) {
        // A stream ends on shutdown, on a lost network or when the session expires.
        failure = error;
      }

      if (controller.signal.aborted) return;
      reconnect = setTimeout(() => void listen(), pace.lost(failure));
    };

    void listen();

    // The gateway seen answering again: no reason to wait for the next try.
    const stopWatching = onlineManager.subscribe((online) => {
      if (!online || reconnect === undefined) return;
      clearTimeout(reconnect);
      void listen();
    });

    return () => {
      stopWatching();
      controller.abort();
      clearTimeout(reconnect);
      reads.stop();
    };
  }, [client, profileId, connection]);
}
