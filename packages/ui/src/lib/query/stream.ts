import { runProgressEventSchema, STREAM_OPENED_EVENT } from '@jian/contracts';
import { onlineManager, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { GatewayEvent } from '../api/events';
import { publish } from '../events';
import { useReconnect } from '../stores/reconnect';
import { panelApi } from './client';
import { keys } from './keys';

/** How long to wait before opening a dropped stream again, in ms, try after try. */
const AGAIN_MS = [1_000, 2_000, 5_000];
/** A stream that lasted this long, in ms, was working: the next drop starts the waits over. */
const STEADY_MS = 30_000;

/**
 * What an event makes stale. A turn changes the conversations and the work in progress; the
 * agent editing itself changes the profile list; a contact or a channel can touch any slice of
 * the profile. None of them asks the providers for their models again.
 */
export function affected(event: GatewayEvent, profileId: string): QueryKey[] {
  const { type } = event;

  // Nothing before this was told, so what the screens read while it opened may have missed some.
  // A stream opens again after the gateway restarts, as it does on an update: its release too.
  if (type === STREAM_OPENED_EVENT) {
    return [
      keys.activities(profileId),
      keys.sessions(profileId),
      keys.contexts(profileId),
      keys.releases,
    ];
  }
  if (type.startsWith('contact.') || type.startsWith('channel.')) return [keys.profile(profileId)];
  // A step taken, a turn ended, a context compacted: each moves how full the context is.
  if (type === 'run.progress') return [keys.activities(profileId), keys.contexts(profileId)];
  if (type.startsWith('run.') || type.startsWith('session.')) {
    return [
      keys.activities(profileId),
      keys.sessions(profileId),
      keys.contexts(profileId),
      // What the agent said may have linked a pull request.
      keys.sessionPulls(profileId),
      // A worktree is made, merged or discarded by a turn, and its counts move as the turn
      // commits. Read again when the turn starts or ends, or one changes: not on each step or
      // each paragraph said, since on a machine every read is a task its worker runs.
      ...(type === 'run.step' || type === 'session.message'
        ? []
        : [keys.sessionWorktrees(profileId)]),
    ];
  }
  if (type.startsWith('profile.')) return [keys.profiles];
  if (type.startsWith('memory.')) return [keys.memories(profileId)];
  // The agent writes schedules too, and every run changes when one ran last.
  if (type.startsWith('schedule.')) return [keys.schedules(profileId)];
  // A merge made in another tab or window: its references and drawer read it again.
  if (type === 'github.pull.merged') {
    return [
      ['integrations', 'github', 'links'],
      ['integrations', 'github', 'pull'],
    ];
  }

  return [];
}

/** How many runs' last activity is remembered before the memory starts over. */
const RUNS_REMEMBERED = 64;

/**
 * What each event makes stale, remembering what each working run was last told doing. A progress
 * frame comes four times a second while a run writes, and the lists it would read again carry the
 * text: every screen showing them would draw again for words only the conversation shows. Only a
 * change of phase, tool or step count is news to them. A frame without progress, from an older
 * gateway, says only that the run moved, and is taken as news every time.
 */
export function staleOf(profileId: string) {
  const doing = new Map<string, string>();

  return (event: GatewayEvent): QueryKey[] => {
    if (event.type === 'run.progress') {
      const told = runProgressEventSchema.safeParse(event.data);
      const progress = told.success ? told.data.progress : undefined;
      if (told.success && progress) {
        const now = JSON.stringify([progress.phase, progress.tool, progress.steps]);
        if (doing.get(told.data.runId) === now) return [];
        if (doing.size >= RUNS_REMEMBERED) doing.clear();
        doing.set(told.data.runId, now);
      }
    }

    return affected(event, profileId);
  };
}

/**
 * Follows the open profile's event stream for as long as its pages are open. A contact request
 * must reach the owner without a reload, so a dropped stream is reopened from the last event
 * seen. Events arrive in bursts as a turn moves; the cache is invalidated once per burst.
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
    const pending = new Map<string, QueryKey>();
    // Unknown until the stream's first event: an opening is from now, not the whole feed.
    let cursor: number | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let flush: ReturnType<typeof setTimeout>;
    let drops = 0;

    const staleFor = staleOf(profileId);
    const invalidate = (event: GatewayEvent) => {
      const stale = staleFor(event);

      if (!stale.length) return;
      for (const key of stale) pending.set(JSON.stringify(key), key);
      clearTimeout(flush);
      flush = setTimeout(() => {
        for (const key of pending.values()) void client.invalidateQueries({ queryKey: key });
        pending.clear();
      }, 200);
    };

    const listen = async () => {
      const opened = Date.now();
      reconnect = undefined;
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
      clearTimeout(flush);
    };
  }, [client, profileId, connection]);
}
