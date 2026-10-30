import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { GatewayEvent } from '../api/events';
import { publish } from '../events';
import { panelApi } from './client';
import { keys } from './keys';

/**
 * What an event makes stale. A turn changes the conversations and the work in progress; the
 * agent editing itself changes the profile list; a contact or a channel can touch any slice of
 * the profile. None of them asks the providers for their models again.
 */
function affected(event: GatewayEvent, profileId: string): QueryKey[] {
  const { type } = event;

  if (type.startsWith('contact.') || type.startsWith('channel.')) return [keys.profile(profileId)];
  if (type === 'run.progress') return [keys.activities(profileId)];
  if (type.startsWith('run.') || type.startsWith('session.')) {
    return [keys.activities(profileId), keys.sessions(profileId)];
  }
  if (type.startsWith('profile.')) return [keys.profiles];
  if (type.startsWith('memory.')) return [keys.memories(profileId)];
  // The agent writes schedules too, and every run changes when one ran last.
  if (type.startsWith('schedule.')) return [keys.schedules(profileId)];
  if (type.startsWith('subscription.')) return [keys.subscriptions(profileId)];
  // A merge made in another tab or window: its references and drawer read it again.
  if (type === 'github.pull.merged') {
    return [
      ['integrations', 'github', 'links'],
      ['integrations', 'github', 'pull'],
    ];
  }

  return [];
}

/**
 * Follows the open profile's event stream for as long as its pages are open. A contact request
 * must reach the owner without a reload, so a dropped stream is reopened from the last event
 * seen. Events arrive in bursts as a turn moves; the cache is invalidated once per burst.
 */
export function useEventStream(profileId: string) {
  const client = useQueryClient();

  useEffect(() => {
    const controller = new AbortController();
    const pending = new Map<string, QueryKey>();
    let cursor = 0;
    let reconnect: ReturnType<typeof setTimeout>;
    let flush: ReturnType<typeof setTimeout>;

    const invalidate = (event: GatewayEvent) => {
      const stale = affected(event, profileId);

      if (!stale.length) return;
      for (const key of stale) pending.set(JSON.stringify(key), key);
      clearTimeout(flush);
      flush = setTimeout(() => {
        for (const key of pending.values()) void client.invalidateQueries({ queryKey: key });
        pending.clear();
      }, 200);
    };

    const listen = async () => {
      try {
        await panelApi().events(
          profileId,
          cursor,
          (event) => {
            cursor = event.id;
            invalidate(event);
            publish(event);
          },
          controller.signal,
        );
      } catch {
        // A stream ends on shutdown, on a lost network or when the session expires.
      }

      if (!controller.signal.aborted) {
        reconnect = setTimeout(() => void listen(), 5000);
      }
    };

    void listen();

    return () => {
      controller.abort();
      clearTimeout(reconnect);
      clearTimeout(flush);
    };
  }, [client, profileId]);
}
