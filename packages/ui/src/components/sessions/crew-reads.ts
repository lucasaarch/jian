'use client';

import { MESSAGES_FIRST_PAGE } from '@jian/contracts';
import { useEffect, useRef, useState } from 'react';
import type { GatewayApi, Message, ToolStep } from '../../lib/api';
import { useCrew } from '../../lib/stores/crew';

/** How long a working agent's drawer waits after one read lands before the next, in ms. */
const POLL_MS = 1500;
/** How many agents' reads the drawer keeps, the latest read last kept longest. */
const KEPT_RUNS = 8;

/** What was last read of one agent: its words, its turn's tools, and why the latest read failed. */
export type AgentRead = { messages?: Message[]; steps?: ToolStep[]; error?: string };

type ReadApi = Pick<GatewayApi, 'messages'> & Partial<Pick<GatewayApi, 'timeline'>>;

const reason = (failure: unknown) =>
  failure instanceof Error ? failure.message : 'The gateway did not answer.';

/** Why a read failed, with what of the agent it could not read. */
function why(messages: PromiseSettledResult<unknown>, tools: PromiseSettledResult<unknown>) {
  if (messages.status === 'rejected' && tools.status === 'rejected')
    return `Could not load this agent: ${reason(messages.reason)}`;
  if (messages.status === 'rejected')
    return `Could not load this agent’s messages: ${reason(messages.reason)}`;
  if (tools.status === 'rejected')
    return `Could not load this agent’s tools: ${reason(tools.reason)}`;
  return undefined;
}

/**
 * The reads with this run's put last, of the agents the open conversation still has, at most
 * `KEPT_RUNS`: the drawer lives as long as the Sessions screen, across every conversation.
 */
function kept(all: Map<string, AgentRead>, runId: string, read: AgentRead) {
  const agents = new Set(useCrew.getState().agents.map((agent) => agent.runId));
  const next = new Map([...all].filter(([id]) => id !== runId && agents.has(id)));
  next.set(runId, read);
  for (const oldest of next.keys()) {
    if (next.size <= KEPT_RUNS) break;
    next.delete(oldest);
  }
  return next;
}

/**
 * What the drawer has read of the agent it follows, kept per run, so another tab never shows
 * this agent's words and coming back shows them at once. A working agent is read again 1.5 s
 * after each read lands, never while one is out: on a slow link, reads that overlap only queue
 * behind each other on the one connection every request shares. A failed read keeps what was
 * read before it and says why; one that lands after the drawer moved on is dropped. The last
 * read, once the agent ends, is tried once more if it fails: it holds the agent's final tools.
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

    /** Whether the read failed, in whole or in part. */
    const fetch = async () => {
      if (stopped) return false;
      const [history, timeline] = await Promise.allSettled([
        api.messages(profileId, place, { limit: MESSAGES_FIRST_PAGE }),
        api.timeline?.(profileId, place, [runId], { brief: true }),
      ]);
      if (stopped) return false;
      const error = why(history, timeline);
      setReads((all) => {
        const was = all.get(runId);
        const turns = timeline.status === 'fulfilled' ? timeline.value : undefined;
        return kept(all, runId, {
          messages: history.status === 'fulfilled' ? history.value : was?.messages,
          steps: turns ? (turns.find((turn) => turn.runId === runId)?.steps ?? []) : was?.steps,
          ...(error ? { error } : {}),
        });
      });
      return Boolean(error);
    };
    const read = () => {
      const flight = (flights.current.get(runId) ?? Promise.resolve()).then(fetch, fetch);
      const settled = flight.then(() => undefined);
      flights.current.set(runId, settled);
      void settled.finally(() => {
        if (flights.current.get(runId) === settled) flights.current.delete(runId);
      });
      return flight;
    };
    const poll = async (retried = false) => {
      const failed = await read();
      if (stopped) return;
      if (working) timer = setTimeout(() => void poll(), POLL_MS);
      else if (failed && !retried) timer = setTimeout(() => void poll(true), POLL_MS);
    };
    void poll();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, profileId, runId, place, working]);

  return runId ? reads.get(runId) : undefined;
}
