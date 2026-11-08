'use client';

import { MESSAGES_FIRST_PAGE } from '@jian/contracts';
import { useEffect, useRef, useState } from 'react';
import type { GatewayApi, Message, ToolStep } from '../../lib/api';

/** How long a working agent's drawer waits after one read lands before the next, in ms. */
const POLL_MS = 1500;

/** What was last read of one agent: its words, its turn's tools, and why the latest read failed. */
export type AgentRead = { messages?: Message[]; steps?: ToolStep[]; error?: string };

type ReadApi = Pick<GatewayApi, 'messages'> & Partial<Pick<GatewayApi, 'timeline'>>;

const why = (failure: unknown) =>
  failure instanceof Error ? failure.message : 'Could not load this agent.';

/**
 * What the drawer has read of the agent it follows, kept per run, so another tab never shows
 * this agent's words and coming back shows them at once. A working agent is read again 1.5 s
 * after each read lands, never while one is out: on a slow link, reads that overlap only queue
 * behind each other on the one connection every request shares. A failed read keeps what was
 * read before it and says why; one that lands after the drawer moved on is dropped.
 *
 * A subagent's session is its own, holding the one turn it was spawned for, so its first page
 * of messages is the whole of it for all but the longest runs. Beyond that page the drawer shows
 * the latest messages and the tools before them stand above the first: there is no earlier page.
 */
export function useAgentRead(
  api: ReadApi,
  profileId: string,
  runId: string | undefined,
  place: string | undefined,
  working: boolean,
): AgentRead | undefined {
  const [reads, setReads] = useState(() => new Map<string, AgentRead>());
  // The read under way for each run. The final read when an agent ends waits for one still out,
  // which may have started before its last tool finished.
  const flights = useRef(new Map<string, Promise<void>>());

  useEffect(() => {
    if (!runId || !place) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fetch = async () => {
      if (stopped) return;
      const [history, timeline] = await Promise.allSettled([
        api.messages(profileId, place, { limit: MESSAGES_FIRST_PAGE }),
        api.timeline?.(profileId, place, [runId], { brief: true }),
      ]);
      if (stopped) return;
      const failed = [history, timeline].find((result) => result.status === 'rejected');
      setReads((all) => {
        const was = all.get(runId);
        const turns = timeline.status === 'fulfilled' ? timeline.value : undefined;
        return new Map(all).set(runId, {
          messages: history.status === 'fulfilled' ? history.value : was?.messages,
          steps: turns ? (turns.find((turn) => turn.runId === runId)?.steps ?? []) : was?.steps,
          ...(failed ? { error: why(failed.reason) } : {}),
        });
      });
    };
    const read = () => {
      const flight = (flights.current.get(runId) ?? Promise.resolve()).then(fetch, fetch);
      flights.current.set(runId, flight);
      return flight.finally(() => {
        if (flights.current.get(runId) === flight) flights.current.delete(runId);
      });
    };
    const poll = async () => {
      await read();
      if (!stopped && working) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, profileId, runId, place, working]);

  return runId ? reads.get(runId) : undefined;
}
