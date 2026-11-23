import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { publish } from '../events';
import { useReconnect } from '../stores/reconnect';
import { panelApi } from './client';
import { staleOf, staleReads } from './stale-events';

/** How long to wait before opening a dropped stream again, in ms, try after try. */
const AGAIN_MS = [1_000, 2_000, 5_000];
/** A stream that lasted this long, in ms, was working: the next drop starts the waits over. */
const STEADY_MS = 30_000;

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
    let drops = 0;

    const staleFor = staleOf(profileId);
    const reads = staleReads(client);

    const listen = async () => {
      const opened = Date.now();
      reconnect = undefined;
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
      } catch {
        // A stream ends on shutdown, on a lost network or when the session expires.
      }

      if (controller.signal.aborted) return;
      drops = Date.now() - opened >= STEADY_MS ? 0 : drops + 1;
      reconnect = setTimeout(() => void listen(), AGAIN_MS[Math.min(drops, AGAIN_MS.length - 1)]);
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
