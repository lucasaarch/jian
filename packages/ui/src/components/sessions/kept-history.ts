'use client';

import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useMemo } from 'react';
import type {
  Message,
  Person,
  Run,
  RunApproval,
  RunQuestion,
  Subagent,
  ToolStep,
} from '../../lib/api';

/**
 * A conversation as it was last read in full, in a form a kept cache can write down: what was
 * said, the tools of each turn, what each turn asked, who spoke and the turn last under way.
 */
export type HistorySnapshot = {
  messages: Message[];
  tools: [string, ToolStep[]][];
  asks: [string, { approval?: RunApproval; question?: RunQuestion }][];
  callTools: [string, ToolStep[]][];
  subagents: Subagent[];
  people: Person[];
  run?: Run;
};

/**
 * The last full read of a conversation, kept with the panel's other reads so a kept cache holds
 * it too: opened again, the conversation shows at once, even with the gateway out of reach.
 * Without a cache around it — a story, a test — nothing is kept.
 */
export function useKeptHistory(profileId: string, sessionId: string) {
  const client = useContext(QueryClientContext);
  return useMemo(() => {
    const key = ['history', profileId, sessionId];
    return {
      kept: client?.getQueryData<HistorySnapshot>(key),
      keep: (snapshot: HistorySnapshot) => client?.setQueryData(key, snapshot),
    };
  }, [client, profileId, sessionId]);
}
